/**
 * Streaming Markdown Sanitizer.
 *
 * Processes text arriving character-by-character from Claude's text_delta
 * events and strips/converts markdown syntax to terminal-friendly output.
 *
 * Handles:
 * - Code fences (```): suppresses fence lines, emits content with dim │ prefix
 * - Inline code (`text`): strips backticks, emits with chalk.cyan()
 * - Bold (**text**): strips markers, emits with chalk.bold()
 * - Headers (# text): strips # prefix, emits with chalk.bold()
 */

import chalk from "chalk";

const enum State {
  Normal,
  /** At line start, accumulating potential fence/header chars */
  LineStart,
  /** Inside a code fence body */
  CodeFence,
  /** Consuming the opening fence line (language tag) */
  CodeFenceOpening,
  /** Inside inline code */
  InlineCode,
  /** Saw one * — waiting to see if it's bold (**) or just italic */
  Star1,
  /** Inside **bold** — accumulating until closing ** */
  Bold,
  /** Inside bold, saw one * — might be closing ** */
  BoldStar1,
}

export class MarkdownStreamer {
  private state: State = State.LineStart;
  private lineStartBuf = ""; // buffer for chars at line start (# or `)
  private inlineCodeBuf = "";
  private boldBuf = "";
  private fenceLineBuf = ""; // current line inside code fence

  /**
   * Feed raw text (may be a single character or many) and get back
   * sanitized text ready for terminal display.
   */
  feed(text: string): string {
    let out = "";
    for (const ch of text) {
      out += this.step(ch);
    }
    return out;
  }

  /**
   * Reset all state. Call between text blocks to prevent state leaking
   * across tool use boundaries.
   */
  reset(): void {
    this.state = State.LineStart;
    this.lineStartBuf = "";
    this.inlineCodeBuf = "";
    this.boldBuf = "";
    this.fenceLineBuf = "";
  }

  /**
   * Flush any remaining buffered content (call at end of text block).
   */
  flush(): string {
    let out = "";

    switch (this.state) {
      case State.LineStart:
        out += this.lineStartBuf;
        this.lineStartBuf = "";
        break;
      case State.InlineCode:
        out += "`" + this.inlineCodeBuf;
        this.inlineCodeBuf = "";
        break;
      case State.Star1:
        out += "*";
        break;
      case State.Bold:
        out += "**" + this.boldBuf;
        this.boldBuf = "";
        break;
      case State.BoldStar1:
        out += "**" + this.boldBuf + "*";
        this.boldBuf = "";
        break;
      case State.CodeFence:
        // Check if buffer is a closing fence (no trailing newline)
        if (!this.fenceLineBuf.match(/^`{3,}\s*$/)) {
          // Not a closing fence — emit as code line
          if (this.fenceLineBuf) {
            out += "  │ " + this.fenceLineBuf;
          }
        }
        // If it IS a closing fence, suppress it (same as newline path)
        this.fenceLineBuf = "";
        break;
      case State.CodeFenceOpening:
        break; // discard opening fence remnant
    }

    this.state = State.LineStart;
    return out;
  }

  private step(ch: string): string {
    switch (this.state) {
      case State.LineStart:
        return this.stepLineStart(ch);
      case State.Normal:
        return this.stepNormal(ch);
      case State.CodeFenceOpening:
        return this.stepCodeFenceOpening(ch);
      case State.CodeFence:
        return this.stepCodeFence(ch);
      case State.InlineCode:
        return this.stepInlineCode(ch);
      case State.Star1:
        return this.stepStar1(ch);
      case State.Bold:
        return this.stepBold(ch);
      case State.BoldStar1:
        return this.stepBoldStar1(ch);
    }
  }

  // ─── Line Start ──────────────────────────────────────────────────────

  private stepLineStart(ch: string): string {
    if (ch === "`") {
      this.lineStartBuf += "`";
      if (this.lineStartBuf === "```") {
        // Opening code fence detected — consume language tag
        this.lineStartBuf = "";
        this.state = State.CodeFenceOpening;
        return "";
      }
      return "";
    }

    if (ch === "#" && this.lineStartBuf.match(/^#*$/)) {
      this.lineStartBuf += "#";
      return "";
    }

    if (ch === " " && this.lineStartBuf.match(/^#+$/)) {
      // Confirmed header — discard the "# " prefix
      this.lineStartBuf = "";
      this.state = State.Normal;
      return ""; // content after the space will render normally
    }

    if (ch === "\n") {
      // Empty line or line with just hashes/backticks
      const buf = this.lineStartBuf;
      this.lineStartBuf = "";
      // state stays LineStart for next line
      return buf + "\n";
    }

    // Not a fence or header — flush buffer and process char normally
    const buf = this.lineStartBuf;
    this.lineStartBuf = "";
    this.state = State.Normal;
    return buf + this.stepNormal(ch);
  }

  // ─── Normal ──────────────────────────────────────────────────────────

  private stepNormal(ch: string): string {
    if (ch === "\n") {
      this.state = State.LineStart;
      this.lineStartBuf = "";
      return "\n";
    }

    if (ch === "`") {
      this.state = State.InlineCode;
      this.inlineCodeBuf = "";
      return "";
    }

    if (ch === "*") {
      this.state = State.Star1;
      return "";
    }

    return ch;
  }

  // ─── Code Fence Opening (consuming language tag) ─────────────────────

  private stepCodeFenceOpening(ch: string): string {
    if (ch === "\n") {
      // Done with opening line — enter fence body
      this.state = State.CodeFence;
      this.fenceLineBuf = "";
      return "";
    }
    // Consume and discard language tag
    return "";
  }

  // ─── Code Fence Body ─────────────────────────────────────────────────

  private stepCodeFence(ch: string): string {
    if (ch === "\n") {
      const line = this.fenceLineBuf;
      this.fenceLineBuf = "";

      // Check for closing fence
      if (line.match(/^`{3,}\s*$/)) {
        // Closing fence — suppress and exit
        this.state = State.LineStart;
        this.lineStartBuf = "";
        return "";
      }

      // Regular code line — plain prefix, handler applies color
      return "  │ " + line + "\n";
    }

    this.fenceLineBuf += ch;
    return "";
  }

  // ─── Inline Code ─────────────────────────────────────────────────────

  private stepInlineCode(ch: string): string {
    if (ch === "`") {
      // Closing backtick
      const text = this.inlineCodeBuf;
      this.inlineCodeBuf = "";
      this.state = State.Normal;
      return chalk.underline(text);
    }

    if (ch === "\n") {
      // Newline inside inline code — shouldn't happen, flush
      const text = this.inlineCodeBuf;
      this.inlineCodeBuf = "";
      this.state = State.LineStart;
      this.lineStartBuf = "";
      return "`" + text + "\n";
    }

    this.inlineCodeBuf += ch;
    return "";
  }

  // ─── Star1 (saw one *) ──────────────────────────────────────────────

  private stepStar1(ch: string): string {
    if (ch === "*") {
      // ** — start of bold
      this.state = State.Bold;
      this.boldBuf = "";
      return "";
    }

    // Single * — emit it and process current char normally
    this.state = State.Normal;
    return "*" + this.stepNormal(ch);
  }

  // ─── Bold (**text**) ─────────────────────────────────────────────────

  private stepBold(ch: string): string {
    if (ch === "*") {
      this.state = State.BoldStar1;
      return "";
    }

    if (ch === "\n") {
      // Newline in bold — flush as bold what we have
      const text = this.boldBuf;
      this.boldBuf = "";
      this.state = State.LineStart;
      this.lineStartBuf = "";
      return chalk.bold(text) + "\n";
    }

    this.boldBuf += ch;
    return "";
  }

  // ─── BoldStar1 (inside bold, saw one *) ──────────────────────────────

  private stepBoldStar1(ch: string): string {
    if (ch === "*") {
      // ** — closing bold
      const text = this.boldBuf;
      this.boldBuf = "";
      this.state = State.Normal;
      return chalk.bold(text);
    }

    // Single * inside bold — it's literal
    this.boldBuf += "*" + ch;
    this.state = State.Bold;
    return "";
  }
}
