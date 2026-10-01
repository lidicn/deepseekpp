import { extractResponseTextFromParsed, isResponseTextPatchPath } from "../deepseek/stream-codec";
import { sanitizeInternalPromptText } from "../prompt";

export function isBatchPatch(parsed: any): boolean {
  return parsed?.o === "BATCH" && Array.isArray(parsed.v);
}

export function isFragmentCreationPatch(parsed: any): boolean {
  return (
    parsed?.p === "response/fragments" &&
    parsed.o === "APPEND" &&
    Array.isArray(parsed.v)
  );
}

export function getDirectPatchText(parsed: any): string | null {
  if (!parsed?.p && typeof parsed?.v === "string") return parsed.v;
  if (
    isResponseTextPatchPath(parsed?.p) &&
    parsed.o === "APPEND" &&
    typeof parsed.v === "string"
  )
    return parsed.v;
  if (
    isResponseTextPatchPath(parsed?.p) &&
    typeof parsed.v === "string" &&
    !parsed.o
  ) {
    return parsed.v;
  }
  if (isFragmentCreationPatch(parsed)) {
    const parts: string[] = [];
    for (const frag of parsed.v) {
      if (frag && typeof frag.content === "string") parts.push(frag.content);
      else if (frag && typeof frag.text === "string") parts.push(frag.text);
    }
    return parts.length > 0 ? parts.join("") : null;
  }
  return null;
}

export function setDirectPatchText(parsed: any, value: string) {
  if (!parsed?.p && typeof parsed?.v === "string") {
    parsed.v = value;
    return;
  }
  if (
    isResponseTextPatchPath(parsed?.p) &&
    parsed.o === "APPEND" &&
    typeof parsed.v === "string"
  ) {
    parsed.v = value;
    return;
  }
  if (
    isResponseTextPatchPath(parsed?.p) &&
    typeof parsed.v === "string" &&
    !parsed.o
  ) {
    parsed.v = value;
    return;
  }
  if (isFragmentCreationPatch(parsed)) {
    let remaining = value;
    for (let i = 0; i < parsed.v.length; i++) {
      const frag = parsed.v[i];
      if (!frag) continue;
      if (typeof frag.content === "string") {
        if (i === parsed.v.length - 1) {
          frag.content = remaining;
        } else {
          const portion = remaining.slice(0, frag.content.length);
          remaining = remaining.slice(frag.content.length);
          frag.content = portion;
        }
      } else if (typeof frag.text === "string") {
        if (i === parsed.v.length - 1) {
          frag.text = remaining;
        } else {
          const portion = remaining.slice(0, frag.text.length);
          remaining = remaining.slice(frag.text.length);
          frag.text = portion;
        }
      }
    }
  }
}

function shouldEmitSanitizedTextPatch(parsed: any): boolean {
  return isBatchPatch(parsed) || isFragmentCreationPatch(parsed);
}

function isAnyFragmentCreationPatch(parsed: any): boolean {
  return (
    typeof parsed?.p === "string" &&
    parsed.p.endsWith("/fragments") &&
    parsed.o === "APPEND" &&
    Array.isArray(parsed.v)
  );
}

function isResponsePatch(parsed: any): boolean {
  if (!parsed || typeof parsed !== "object") return false;
  if (!parsed.p) return true;
  return (
    typeof parsed.p === "string" &&
    (parsed.p === "response" || parsed.p.startsWith("response/"))
  );
}

function getAnyDirectPatchText(parsed: any): string | null {
  if (!parsed?.p && typeof parsed?.v === "string") return parsed.v;
  if (parsed?.p && parsed.o === "APPEND" && typeof parsed.v === "string")
    return parsed.v;
  if (
    typeof parsed?.p === "string" &&
    typeof parsed.v === "string" &&
    !parsed.o
  ) {
    const lastSegment = parsed.p.split("/").pop();
    if (
      lastSegment === "content" ||
      lastSegment === "text" ||
      lastSegment === "markdown" ||
      lastSegment === "delta"
    ) {
      return parsed.v;
    }
  }
  if (isAnyFragmentCreationPatch(parsed)) {
    const parts: string[] = [];
    for (const frag of parsed.v) {
      if (frag && typeof frag.content === "string") parts.push(frag.content);
      else if (frag && typeof frag.text === "string") parts.push(frag.text);
    }
    return parts.length > 0 ? parts.join("") : null;
  }
  return null;
}

function setAnyDirectPatchText(parsed: any, value: string) {
  if (!parsed?.p && typeof parsed?.v === "string") {
    parsed.v = value;
    return;
  }
  if (parsed?.p && parsed.o === "APPEND" && typeof parsed.v === "string") {
    parsed.v = value;
    return;
  }
  if (
    typeof parsed?.p === "string" &&
    typeof parsed.v === "string" &&
    !parsed.o
  ) {
    parsed.v = value;
    return;
  }
  if (isAnyFragmentCreationPatch(parsed)) {
    let remaining = value;
    for (let i = 0; i < parsed.v.length; i++) {
      const frag = parsed.v[i];
      if (!frag) continue;
      if (typeof frag.content === "string") {
        if (i === parsed.v.length - 1) {
          frag.content = remaining;
        } else {
          const portion = remaining.slice(0, frag.content.length);
          remaining = remaining.slice(frag.content.length);
          frag.content = portion;
        }
      } else if (typeof frag.text === "string") {
        if (i === parsed.v.length - 1) {
          frag.text = remaining;
        } else {
          const portion = remaining.slice(0, frag.text.length);
          remaining = remaining.slice(frag.text.length);
          frag.text = portion;
        }
      }
    }
  }
}

export function cloneParsedWithSanitizedInternalPrompt(
  parsed: any,
  visiblePrompt: string,
): any | null {
  const cloned = structuredClone(parsed);
  let changed = false;

  const apply = (node: any) => {
    if (!node || typeof node !== "object") return;

    if (isBatchPatch(node)) {
      for (const item of node.v) {
        apply(item);
      }
      return;
    }

    const text = getAnyDirectPatchText(node);
    if (text === null) return;

    const isResponseText = isResponsePatch(node);
    const sanitized = sanitizeInternalPromptText(
      text,
      isResponseText ? undefined : visiblePrompt,
    );
    if (sanitized === text) return;

    setAnyDirectPatchText(node, isResponseText ? "" : sanitized);
    changed = true;
  };

  apply(cloned);

  return changed ? cloned : null;
}

/**
 * Cross-frame fence state for blank-line collapsing. Fenced code blocks are
 * streamed across many SSE frames; the opening ``` often arrives in an
 * earlier frame than the interior blank-line runs, so the fence position must
 * be carried between frames instead of being recomputed frame-locally.
 */
export interface BlankLineCollapseFenceState {
  inFence: boolean;
}

export function cloneParsedWithCollapsedBlankLines(
  parsed: any,
  fenceState: BlankLineCollapseFenceState,
): any | null {
  const cloned = structuredClone(parsed);
  let changed = false;

  const apply = (node: any) => {
    if (!node || typeof node !== "object") return;

    if (isBatchPatch(node)) {
      for (const item of node.v) {
        apply(item);
      }
      return;
    }

    const text = getAnyDirectPatchText(node);
    if (text === null) return;

    const collapsed = collapseExcessBlankLines(text, fenceState);
    if (collapsed === text) return;

    setAnyDirectPatchText(node, collapsed);
    changed = true;
  };

  apply(cloned);

  return changed ? cloned : null;
}

/**
 * Collapses runs of 3+ newlines outside fenced code blocks down to a single
 * paragraph break (`\n\n`). Agent-mode output often wraps tool calls in
 * `\n\n\n`; collapsing matches how the DeepSeek page's own markdown renderer
 * displays paragraph spacing, while blank lines inside ``` fences are kept
 * intact for `<pre>` rendering.
 *
 * `fenceState` is the filter's cross-frame fence tracker: a fence opened in an
 * earlier SSE frame protects the current frame's interior blank lines too,
 * instead of the frame-local toggle collapsing them (the cross-frame code
 * block corruption bug).
 */
export function collapseExcessBlankLines(
  text: string,
  fenceState: BlankLineCollapseFenceState,
): string {
  if (!text.includes("```")) {
    // No fence marker in this frame: collapse only while we are outside any
    // code block. The `fenceState` carry makes a frame that only contains
    // blank lines (inside a fence opened earlier) pass through untouched.
    if (fenceState.inFence || !text.includes("\n\n\n")) return text;
    return text.replace(/\n{3,}/g, "\n\n");
  }

  let output = "";
  let cursor = 0;
  while (cursor < text.length) {
    const fenceIndex = text.indexOf("```", cursor);
    if (fenceIndex === -1) {
      output += fenceState.inFence
        ? text.slice(cursor)
        : text.slice(cursor).replace(/\n{3,}/g, "\n\n");
      break;
    }
    const segment = text.slice(cursor, fenceIndex);
    output += fenceState.inFence
      ? segment
      : segment.replace(/\n{3,}/g, "\n\n");
    output += "```";
    fenceState.inFence = !fenceState.inFence;
    cursor = fenceIndex + 3;
  }
  return output;
}

export function extractCleanResponseTextForParsing(parsed: unknown): string | null {
  const text = extractResponseTextFromParsed(parsed);
  if (!text) return text;

  const sanitized = sanitizeInternalPromptText(text);
  return sanitized === text ? text : "";
}

export function cloneParsedWithTextPrefix(parsed: any, keepChars: number): any | null {
  const cloned = structuredClone(parsed);
  let remaining = Math.max(0, keepChars);
  let touchedText = false;

  const apply = (node: any) => {
    if (!node || typeof node !== "object") return;

    if (isBatchPatch(node)) {
      for (const item of node.v) {
        apply(item);
      }
      return;
    }

    const text = getDirectPatchText(node);
    if (text === null) return;

    touchedText = true;
    const nextText = remaining > 0 ? text.slice(0, remaining) : "";
    remaining = Math.max(0, remaining - text.length);
    setDirectPatchText(node, nextText);
  };

  apply(cloned);

  if (!touchedText) return null;
  if (keepChars <= 0 && !shouldEmitSanitizedTextPatch(cloned)) return null;
  return cloned;
}

export function cloneParsedWithTextSuffix(parsed: any, skipChars: number): any | null {
  const cloned = structuredClone(parsed);
  let remainingSkip = Math.max(0, skipChars);
  let touchedText = false;
  let keptText = false;

  const apply = (node: any) => {
    if (!node || typeof node !== "object") return;

    if (isBatchPatch(node)) {
      for (const item of node.v) {
        apply(item);
      }
      return;
    }

    const text = getDirectPatchText(node);
    if (text === null) return;

    touchedText = true;
    if (remainingSkip >= text.length) {
      remainingSkip -= text.length;
      setDirectPatchText(node, "");
      return;
    }

    const nextText = text.slice(remainingSkip);
    remainingSkip = 0;
    if (nextText.length > 0) keptText = true;
    setDirectPatchText(node, nextText);
  };

  apply(cloned);

  if (!touchedText || !keptText) return null;
  return cloned;
}

