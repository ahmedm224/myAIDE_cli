import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";

interface TextAreaProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  placeholder?: string;
  disabled?: boolean;
  maxHeight?: number;
  label?: string;
}

export const TextArea: React.FC<TextAreaProps> = ({
  value,
  onChange,
  onSubmit,
  placeholder = "",
  disabled = false,
  maxHeight = 5,
  label,
}) => {
  const [cursorPosition, setCursorPosition] = useState<number>(value.length);
  const [preferredColumn, setPreferredColumn] = useState<number | null>(null);
  const [lastValue, setLastValue] = useState<string>(value);

  // Track terminal width so we can provide a horizontal viewport for long lines.
  const terminalWidth = process.stdout.columns ?? 80;
  // Allow full width minus minimal padding for borders (4 chars: left border, padding, right border, padding)
  const viewportWidth = useMemo(() => Math.max(40, terminalWidth - 6), [terminalWidth]);

  const normalisedValue = useMemo(() => value.replace(/\r\n?/g, "\n"), [value]);

  // Sync cursor to end when value changes externally (cleared, replaced, etc.)
  useEffect(() => {
    const normalisedLast = lastValue.replace(/\r\n?/g, "\n");

    // If value changed externally (not from our own input), reset cursor to end
    if (normalisedValue !== normalisedLast) {
      setLastValue(value);
      setCursorPosition(normalisedValue.length);
      setPreferredColumn(null);
    }
  }, [value, normalisedValue, lastValue]);

  useEffect(() => {
    if (cursorPosition > normalisedValue.length) {
      setCursorPosition(normalisedValue.length);
      setPreferredColumn(null);
    }
  }, [normalisedValue.length, cursorPosition]);
  const lines = normalisedValue.split("\n");
  const totalLines = lines.length;

  // Determine the cursor's line and column based on the absolute position.
  let charCount = 0;
  let cursorLine = 0;
  let cursorColumn = 0;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const currentLine = lines[lineIndex];
    const lineLength = currentLine.length;
    if (charCount + lineLength >= cursorPosition) {
      cursorLine = lineIndex;
      cursorColumn = cursorPosition - charCount;
      break;
    }
    charCount += lineLength + 1; // account for newline
  }

  // Vertical window around the cursor with scroll indicators.
  const startLine = Math.max(0, Math.min(cursorLine - Math.floor(maxHeight / 2), Math.max(0, totalLines - maxHeight)));
  const endLine = Math.min(totalLines, startLine + maxHeight);
  const visibleLines = lines.slice(startLine, endLine);

  const moveCursor = (position: number, preferred?: number | null, lengthHint?: number) => {
    const limit = lengthHint ?? normalisedValue.length;
    setCursorPosition(Math.max(0, Math.min(limit, position)));
    setPreferredColumn(preferred ?? null);
  };

  const handleChange = (newValue: string) => {
    setLastValue(newValue);
    onChange(newValue);
  };

  useInput((input, key) => {
    if (disabled) return;

    if (key.return && !key.shift) {
      onSubmit();
      return;
    }

    if (key.return && key.shift) {
      const before = normalisedValue.slice(0, cursorPosition);
      const after = normalisedValue.slice(cursorPosition);
      handleChange(`${before}\n${after}`);
      moveCursor(cursorPosition + 1, null, normalisedValue.length + 1);
      return;
    }

    // Backspace: delete character BEFORE cursor
    if (key.backspace) {
      if (cursorPosition > 0) {
        const before = normalisedValue.slice(0, cursorPosition - 1);
        const after = normalisedValue.slice(cursorPosition);
        handleChange(before + after);
        moveCursor(cursorPosition - 1, null, Math.max(0, normalisedValue.length - 1));
      }
      return;
    }

    // Delete: delete character AT/AFTER cursor
    if (key.delete) {
      if (cursorPosition < normalisedValue.length) {
        const before = normalisedValue.slice(0, cursorPosition);
        const after = normalisedValue.slice(cursorPosition + 1);
        handleChange(before + after);
        moveCursor(cursorPosition, preferredColumn, Math.max(0, normalisedValue.length - 1));
      }
      return;
    }

    if (key.leftArrow) {
      if (key.ctrl || key.meta) {
        let pos = cursorPosition;
        while (pos > 0 && /\s/.test(normalisedValue[pos - 1])) pos -= 1;
        while (pos > 0 && !/\s/.test(normalisedValue[pos - 1])) pos -= 1;
        moveCursor(pos);
      } else {
        moveCursor(cursorPosition - 1);
      }
      return;
    }

    if (key.rightArrow) {
      if (key.ctrl || key.meta) {
        let pos = cursorPosition;
        while (pos < normalisedValue.length && /\s/.test(normalisedValue[pos])) pos += 1;
        while (pos < normalisedValue.length && !/\s/.test(normalisedValue[pos])) pos += 1;
        moveCursor(pos);
      } else {
        moveCursor(cursorPosition + 1);
      }
      return;
    }

    if (key.upArrow) {
      if (cursorLine > 0) {
        const desiredColumn = preferredColumn ?? cursorColumn;
        const targetColumn = Math.min(desiredColumn, lines[cursorLine - 1].length);
        let newPos = 0;
        for (let i = 0; i < cursorLine - 1; i += 1) {
          newPos += lines[i].length + 1;
        }
        newPos += targetColumn;
        moveCursor(newPos, desiredColumn);
      } else {
        moveCursor(0, 0);
      }
      return;
    }

    if (key.downArrow) {
      if (cursorLine < totalLines - 1) {
        const desiredColumn = preferredColumn ?? cursorColumn;
        const targetColumn = Math.min(desiredColumn, lines[cursorLine + 1].length);
        let newPos = 0;
        for (let i = 0; i <= cursorLine; i += 1) {
          newPos += lines[i].length + 1;
        }
        newPos += targetColumn;
        moveCursor(newPos, desiredColumn);
      } else {
        moveCursor(normalisedValue.length, cursorColumn);
      }
      return;
    }

    if (input === "\x01") {
      let newPos = 0;
      for (let i = 0; i < cursorLine; i += 1) {
        newPos += lines[i].length + 1;
      }
      moveCursor(newPos, 0);
      return;
    }

    if (input === "\x05") {
      let newPos = 0;
      for (let i = 0; i < cursorLine; i += 1) {
        newPos += lines[i].length + 1;
      }
      newPos += lines[cursorLine].length;
      moveCursor(newPos, lines[cursorLine].length);
      return;
    }

    // Ctrl+K: Delete current line
    if (input === "\x0b") {
      // Calculate start and end of current line
      let lineStart = 0;
      for (let i = 0; i < cursorLine; i += 1) {
        lineStart += lines[i].length + 1;
      }
      const lineEnd = lineStart + lines[cursorLine].length;

      if (totalLines === 1) {
        // If only one line, clear it
        handleChange("");
        moveCursor(0, 0, 0);
      } else if (cursorLine === totalLines - 1) {
        // Last line: remove line and preceding newline
        const before = normalisedValue.slice(0, lineStart - 1);
        handleChange(before);
        moveCursor(Math.min(cursorPosition, before.length), preferredColumn, Math.max(0, before.length));
      } else {
        // Middle line: remove line and its newline
        const before = normalisedValue.slice(0, lineStart);
        const after = normalisedValue.slice(lineEnd + 1);
        handleChange(before + after);
        moveCursor(lineStart, preferredColumn, Math.max(0, before.length + after.length));
      }
      return;
    }

    if (input && !key.ctrl && !key.meta && input.length >= 1) {
      const incoming = input.replace(/\r\n?/g, "\n");
      const before = normalisedValue.slice(0, cursorPosition);
      const after = normalisedValue.slice(cursorPosition);
      handleChange(before + incoming + after);
      moveCursor(cursorPosition + incoming.length, null, normalisedValue.length + incoming.length);
    }
  }, { isActive: !disabled });

  const renderLine = (line: string, isCurrent: boolean, absoluteIndex: number, index: number) => {
    const lineLength = line.length;
    let sliceStart = 0;
    if (isCurrent) {
      if (cursorColumn >= viewportWidth) {
        sliceStart = cursorColumn - viewportWidth + 1;
      }
      sliceStart = Math.min(sliceStart, Math.max(0, lineLength - viewportWidth + 1));
    }
    const sliceEnd = sliceStart + viewportWidth;
    const slicedLine = line.slice(sliceStart, sliceEnd);
    const leftIndicator = sliceStart > 0;
    const rightIndicator = sliceEnd < lineLength;

    if (!isCurrent) {
      return (
        <Box key={absoluteIndex}>
          {leftIndicator && <Text color="gray">…</Text>}
          <Text>{slicedLine || " "}</Text>
          {rightIndicator && <Text color="gray">…</Text>}
        </Box>
      );
    }

    const relativeCursor = Math.max(0, Math.min(cursorColumn - sliceStart, slicedLine.length));
    const beforeCursor = slicedLine.substring(0, relativeCursor);
    const afterCursor = slicedLine.substring(relativeCursor);

    return (
      <Box key={absoluteIndex}>
        {leftIndicator && <Text color="gray">…</Text>}
        <Text>{beforeCursor}</Text>
        <Text backgroundColor="white" color="black">█</Text>
        <Text>{afterCursor}</Text>
        {rightIndicator && <Text color="gray">…</Text>}
      </Box>
    );
  };

  const renderHeight = Math.max(1, Math.min(maxHeight, visibleLines.length || totalLines || 1));

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1} paddingY={0}>
      {label && <Text color="white" bold>{label}</Text>}

      {startLine > 0 && (
        <Text color="gray" dimColor>
          ↑ {startLine} line{startLine > 1 ? "s" : ""} above • Ctrl+Arrows: skip words
        </Text>
      )}

      <Box flexDirection="column" height={renderHeight}>
        {visibleLines.length === 0 || (visibleLines.length === 1 && visibleLines[0] === "") ? (
          <Text color="gray" dimColor>{placeholder}</Text>
        ) : (
          visibleLines.map((line, idx) => renderLine(line, startLine + idx === cursorLine, startLine + idx, idx))
        )}
      </Box>

      {endLine < totalLines && (
        <Text color="gray" dimColor>
          ↓ {totalLines - endLine} line{totalLines - endLine > 1 ? "s" : ""} below
        </Text>
      )}

      <Text color="gray" dimColor>
        Shift+Enter: newline • Enter: submit • Ctrl+A/E: line start/end • Ctrl+K: delete line
      </Text>
    </Box>
  );
};
