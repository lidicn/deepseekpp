import type { ToolCall, ToolDescriptor } from "../types";
import {
  findFirstXmlToolTag,
  getPartialXmlToolTagTailLength,
} from "../tool/xml-tags";
import { extractToolCalls } from "./tool-parser";
import type { RequestContext } from "./hook-state";
import type { DeepSeekSseFrame } from "../deepseek/stream-codec";
import { replaceDeepSeekSseFrameData, extractResponseTextFromParsed } from "../deepseek/stream-codec";
import { createToolInvocationCatalog } from "../tool";
import {
  isBatchPatch,
  isFragmentCreationPatch,
  cloneParsedWithSanitizedInternalPrompt,
  cloneParsedWithTextPrefix,
  cloneParsedWithTextSuffix,
  cloneParsedWithCollapsedBlankLines,
  type BlankLineCollapseFenceState,
} from "./response-patch";
export class XmlToolStreamFilter {
  private toolInvocationNameSet: ReadonlySet<string>;
  private visiblePrompt: string;
  private state: "NORMAL" | "SUPPRESSING" = "NORMAL";
  private currentTool: string | null = null;
  private pendingText = "";
  private pendingBlocks: Array<{
    block: string;
    separator: string;
    sourceFrame: DeepSeekSseFrame;
    isFragmentCreation: boolean;
    parsed: any;
  }> = [];
  private encoder = new TextEncoder();
  /**
   * True while the tail following a stripped tool-call block must have its
   * leading blank lines removed. Model output separates tool calls with
   * `\n\n` on both sides; stripping only the XML tags would leave
   * `\n\n\n\n` (the "blank line between every row" rendering bug on the
   * DeepSeek page) instead of the original single paragraph break.
   */
  private stripTailLeadingNewlines = false;
  /**
   * Whether the last emitted text ended with a newline. Needed when a tool
   * call opens at the start of a fresh SSE frame: the text before it was
   * already flushed, so the blank-line collapse must consult the previously
   * emitted text instead of the (empty) current buffer.
   */
  private lastEmittedTextEndsWithNewline = false;
  /**
   * Cross-frame fenced-code state for blank-line collapsing: a fence opened
   * in an earlier frame keeps protecting this frame's interior blank lines.
   * One state per filter instance (one per intercepted response).
   */
  private readonly blankLineFenceState: BlankLineCollapseFenceState = {
    inFence: false,
  };

  constructor(
    descriptors: readonly ToolDescriptor[] = [],
    visiblePrompt: string = "",
  ) {
    this.visiblePrompt = visiblePrompt;
    this.toolInvocationNameSet = new Set(
      createToolInvocationCatalog(descriptors).invocationNames,
    );
  }

  processFrames(
    frames: readonly DeepSeekSseFrame[],
    controller: ReadableStreamDefaultController<Uint8Array>,
  ) {
    for (const frame of frames) {
      if (!frame.block.trim() || !frame.event || !frame.parsed) {
        this.emit(controller, frame.block, frame.separator);
        continue;
      }

      const sanitizedParsed = cloneParsedWithSanitizedInternalPrompt(
        frame.parsed,
        this.visiblePrompt,
      );
      const effectiveParsed = sanitizedParsed ?? frame.parsed;
      const effectiveBlock = sanitizedParsed
        ? replaceDeepSeekSseFrameData(frame, JSON.stringify(sanitizedParsed))
        : frame.block;
      const text = extractResponseTextFromParsed(effectiveParsed);
      if (text === null) {
        // Non-response events, including request-message echoes, pass through after prompt cleanup.
        this.emit(controller, effectiveBlock, frame.separator);
        continue;
      }

      // Determine if this event is a "structural" one (fragment creation) that must pass through
      const isFragmentCreation = isFragmentCreationPatch(effectiveParsed);

      // Text event — apply state machine
      if (this.state === "SUPPRESSING") {
        const previousPendingLength = this.pendingText.length;
        const searchText = this.pendingText + text;
        const closeTag = this.findFirstToolClose(searchText, this.currentTool!);
        if (closeTag) {
          const tailStart = closeTag.endIndex;
          const tailOffsetInCurrentText = tailStart - previousPendingLength;
          const toolTail = this.getCurrentToolTail(
            effectiveParsed,
            text,
            isFragmentCreation,
            tailOffsetInCurrentText,
            frame,
          );
          this.state = "NORMAL";
          this.pendingText = "";
          this.currentTool = null;
          if (toolTail) {
            this.processNormalTextBlock(
              controller,
              toolTail.block,
              toolTail.separator,
              toolTail.sourceFrame,
              toolTail.parsed,
              toolTail.text,
              toolTail.isFragmentCreation,
            );
          }
          continue;
        }
        this.pendingText = this.getCloseSearchTail(
          searchText,
          this.currentTool!,
        );
        if (isFragmentCreation || isBatchPatch(effectiveParsed)) {
          const modified = cloneParsedWithTextPrefix(effectiveParsed, 0);
          if (modified) {
            this.emit(
              controller,
              replaceDeepSeekSseFrameData(frame, JSON.stringify(modified)),
              frame.separator,
            );
          }
        }
        continue;
      }

      // State: NORMAL
      this.processNormalTextBlock(
        controller,
        effectiveBlock,
        frame.separator,
        frame,
        effectiveParsed,
        text,
        isFragmentCreation,
      );
    }
  }

  private processNormalTextBlock(
    controller: ReadableStreamDefaultController<Uint8Array>,
    block: string,
    separator: string,
    sourceFrame: DeepSeekSseFrame,
    parsed: any,
    text: string,
    isFragmentCreation: boolean,
  ) {
    // A tool-call block was stripped right before this text: drop its leading
    // blank lines so the `\n\n` left by the stripped block does not stack on
    // top of the `\n\n` the model already emitted after the closing tag
    // (the "blank line between every row" rendering bug on the DeepSeek page).
    if (this.stripTailLeadingNewlines) {
      const leadingNewlines = /^\n+/.exec(text);
      if (leadingNewlines) {
        const modified = cloneParsedWithTextSuffix(
          parsed,
          leadingNewlines[0].length,
        );
        if (!modified) {
          // The tail is nothing but blank lines: drop this frame entirely and
          // keep the flag so the next non-blank text block still gets trimmed.
          return;
        }
        const modifiedText = extractResponseTextFromParsed(modified);
        if (!modifiedText) {
          return;
        }
        parsed = modified;
        text = modifiedText;
        block = replaceDeepSeekSseFrameData(
          sourceFrame,
          JSON.stringify(modified),
        );
        this.stripTailLeadingNewlines = false;
      } else {
        this.stripTailLeadingNewlines = false;
      }
    }

    const previousPendingLength = this.pendingText.length;
    this.pendingText += text;
    this.pendingBlocks.push({
      block,
      separator,
      sourceFrame,
      isFragmentCreation,
      parsed,
    });

    const found = this.findFirstToolOpen(this.pendingText);
    if (found) {
      const closeTag = this.findFirstToolClose(
        this.pendingText,
        found.tool,
        found.endIndex,
      );
      const tailStart = closeTag ? closeTag.endIndex : -1;
      const tailOffsetInCurrentText = tailStart - previousPendingLength;

      // Model output separates every tool call with blank lines on both
      // sides; remember that so the text after the stripped block has its
      // leading blank lines removed instead of stacking `\n\n\n\n`. When the
      // tool call opens at the start of a fresh frame, the preceding text was
      // already flushed — fall back to the last emitted text's ending.
      let textBeforeOpen = this.pendingText.slice(0, found.idx);
      // Collapse excess blank lines right before the open tag down to a
      // single paragraph break: agent-mode output often uses `\n\n\n` around
      // tool calls, and without this the stripped text keeps a blank row.
      const collapsedBeforeOpen = textBeforeOpen.replace(/\n{3,}$/, "\n\n");
      const openIdx =
        found.idx - (textBeforeOpen.length - collapsedBeforeOpen.length);
      textBeforeOpen = collapsedBeforeOpen;
      this.stripTailLeadingNewlines =
        textBeforeOpen.length > 0
          ? /\n$/.test(textBeforeOpen)
          : this.lastEmittedTextEndsWithNewline;
      this.emitBlocksBeforeOpen(controller, openIdx);
      this.pendingBlocks = [];

      if (!closeTag) {
        this.state = "SUPPRESSING";
        this.currentTool = found.tool;
        this.pendingText = this.getCloseSearchTail(
          this.pendingText.slice(found.idx),
          found.tool,
        );
        return;
      }

      this.state = "NORMAL";
      this.currentTool = null;
      this.pendingText = "";
      const toolTail = this.getCurrentToolTail(
        parsed,
        text,
        isFragmentCreation,
        tailOffsetInCurrentText,
        sourceFrame,
      );
      if (toolTail) {
        this.processNormalTextBlock(
          controller,
          toolTail.block,
          toolTail.separator,
          toolTail.sourceFrame,
          toolTail.parsed,
          toolTail.text,
          toolTail.isFragmentCreation,
        );
      }
      return;
    }

    if (this.couldBePartialToolOpen(this.pendingText)) {
      return;
    }

    // Safe — flush all pending
    for (const b of this.pendingBlocks) {
      this.emitCollapsedTrailingNewlines(controller, b);
    }
    this.lastEmittedTextEndsWithNewline = /\n$/.test(this.pendingText);
    this.pendingBlocks = [];
    this.pendingText = "";
  }

  /**
   * Collapses excess blank lines (3+ consecutive newlines) down to a single
   * paragraph break (`\n\n`). Agent-mode output often wraps tool calls in
   * `\n\n\n`; when the text around a stripped tool call has already been
   * flushed to previous SSE frames, the blank lines can no longer be trimmed
   * at the open/close tags, so they are collapsed here instead. Keeping at
   * most one blank line matches how the DeepSeek page's own markdown renderer
   * displays the same source.
   */
  private emitCollapsedTrailingNewlines(
    controller: ReadableStreamDefaultController<Uint8Array>,
    entry: {
      block: string;
      separator: string;
      sourceFrame: DeepSeekSseFrame;
      isFragmentCreation: boolean;
      parsed: any;
    },
  ) {
    const modified = cloneParsedWithCollapsedBlankLines(
      entry.parsed,
      this.blankLineFenceState,
    );
    if (modified === null) {
      this.emit(controller, entry.block, entry.separator);
      return;
    }
    this.emit(
      controller,
      replaceDeepSeekSseFrameData(entry.sourceFrame, JSON.stringify(modified)),
      entry.separator,
    );
  }

  private getCurrentToolTail(
    parsed: any,
    text: string,
    isFragmentCreation: boolean,
    tailOffsetInCurrentText: number,
    sourceFrame: DeepSeekSseFrame,
  ): {
    block: string;
    separator: string;
    sourceFrame: DeepSeekSseFrame;
    parsed: any;
    text: string;
    isFragmentCreation: boolean;
  } | null {
    if (tailOffsetInCurrentText >= text.length) return null;

    const modified = cloneParsedWithTextSuffix(
      parsed,
      Math.max(0, tailOffsetInCurrentText),
    );
    if (!modified) return null;

    const modifiedText = extractResponseTextFromParsed(modified);
    if (!modifiedText) return null;

    return {
      block: replaceDeepSeekSseFrameData(sourceFrame, JSON.stringify(modified)),
      separator: sourceFrame.separator,
      sourceFrame,
      parsed: modified,
      text: modifiedText,
      isFragmentCreation:
        isFragmentCreation || isFragmentCreationPatch(modified),
    };
  }

  private getCloseSearchTail(text: string, tool: string): string {
    const tailLength = getPartialXmlToolTagTailLength(text, new Set([tool]), {
      closing: true,
    });
    return tailLength > 0 ? text.slice(-tailLength) : "";
  }

  flush(controller: ReadableStreamDefaultController<Uint8Array>) {
    // Flush any unsent pending blocks (they were buffered as potential tool start but never confirmed)
    for (const b of this.pendingBlocks) {
      this.emitCollapsedTrailingNewlines(controller, b);
    }
    this.pendingBlocks = [];
    this.pendingText = "";
  }

  private emit(
    controller: ReadableStreamDefaultController<Uint8Array>,
    block: string,
    separator: string,
  ) {
    // Released passive output always terminated a final buffered frame. Keep
    // that EOF contract while preserving an explicit LF/CRLF separator.
    controller.enqueue(this.encoder.encode(block + (separator || "\n\n")));
  }

  private findFirstToolOpen(
    text: string,
  ): { idx: number; endIndex: number; tool: string } | null {
    const match = findFirstXmlToolTag(text, this.toolInvocationNameSet, {
      closing: false,
    });
    return match
      ? { idx: match.index, endIndex: match.endIndex, tool: match.name }
      : null;
  }

  private findFirstToolClose(
    text: string,
    tool: string,
    fromIndex = 0,
  ): { index: number; endIndex: number } | null {
    const match = findFirstXmlToolTag(text, new Set([tool]), {
      closing: true,
      fromIndex,
    });
    return match ? { index: match.index, endIndex: match.endIndex } : null;
  }

  private couldBePartialToolOpen(text: string): boolean {
    return (
      getPartialXmlToolTagTailLength(text, this.toolInvocationNameSet, {
        closing: false,
      }) > 0
    );
  }

  private emitBlocksBeforeOpen(
    controller: ReadableStreamDefaultController<Uint8Array>,
    idx: number,
  ) {
    let charsSeen = 0;

    for (const entry of this.pendingBlocks) {
      const text = extractResponseTextFromParsed(entry.parsed);
      if (text === null) {
        this.emit(controller, entry.block, entry.separator);
        continue;
      }
      if (charsSeen + text.length <= idx) {
        this.emitCollapsedTrailingNewlines(controller, entry);
        charsSeen += text.length;
      } else {
        const keepChars = idx - charsSeen;
        if (
          keepChars > 0 ||
          entry.isFragmentCreation ||
          isBatchPatch(entry.parsed)
        ) {
          const modified = cloneParsedWithTextPrefix(entry.parsed, keepChars);
          if (modified) {
            const collapsed = cloneParsedWithCollapsedBlankLines(
              modified,
              this.blankLineFenceState,
            );
            const effective = collapsed ?? modified;
            this.emit(
              controller,
              replaceDeepSeekSseFrameData(
                entry.sourceFrame,
                JSON.stringify(effective),
              ),
              entry.separator,
            );
          }
        }
        break;
      }
    }
    // The text emitted here is everything before the tool-call open tag
    // (plus the open tag itself when keepChars covered it). Track whether it
    // ended on a newline so a tool call that opens at the start of the next
    // frame can still collapse the blank lines correctly.
    this.lastEmittedTextEndsWithNewline = /\n$/.test(
      this.pendingText.slice(0, idx),
    );
  }
}

