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

  // Track terminal width so we can provide a horizontal viewport for long lines.
  const terminalWidth = process.stdout.columns ?? 80;
  const viewportWidth = useMemo(() => Math.max(20, Math.min(terminalWidth - 10, 120)), [terminalWidth]);

  useEffect(() => {
    if (cursorPosition > value.length) {
      setCursorPosition(value.length);
      setPreferredColumn(null);
    }
  }, [value.length, cursorPosition]);

  const lines = value.split("\n");
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

  const moveCursor = (position: number, preferred?: number | null) => {
    setCursorPosition(Math.max(0, Math.min(value.length, position)));
    setPreferredColumn(preferred ?? null);
  };

  useInput((input, key) => {
    if (disabled) return;

    if (key.return && !key.shift) {
      onSubmit();
      return;
    }

    if (key.return && key.shift) {
      const before = value.slice(0, cursorPosition);
      const after = value.slice(cursorPosition);
      onChange(`${before}\n${after}`);
      moveCursor(cursorPosition + 1);
      return;
    }

    if (key.backspace || key.delete) {
      if (cursorPosition > 0) {
        const before = value.slice(0, cursorPosition - 1);
        const after = value.slice(cursorPosition);
        onChange(before + after);
        moveCursor(cursorPosition - 1);
      }
      return;
    }

    if (key.leftArrow) {
      if (key.ctrl || key.meta) {
        let pos = cursorPosition;
        while (pos > 0 && /\s/.test(value[pos - 1])) pos -= 1;
        while (pos > 0 && !/\s/.test(value[pos - 1])) pos -= 1;
        moveCursor(pos);
      } else {
        moveCursor(cursorPosition - 1);
      }
      return;
    }

    if (key.rightArrow) {
      if (key.ctrl || key.meta) {
        let pos = cursorPosition;
        while (pos < value.length && /\s/.test(value[pos])) pos += 1;
        while (pos < value.length && !/\s/.test(value[pos])) pos += 1;
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
        moveCursor(value.length, cursorColumn);
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

    if (input && !key.ctrl && !key.meta && input.length >= 1) {
      const before = value.slice(0, cursorPosition);
      const after = value.slice(cursorPosition);
      onChange(before + input + after);
      moveCursor(cursorPosition + input.length);
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

    const relativeCursor = Math.max(0, Math.min(cursorColumn - sliceStart, viewportWidth - 1));
    const beforeCursor = slicedLine.substring(0, relativeCursor);
    const cursorChar = slicedLine[relativeCursor] ?? " ";
    const afterCursor = relativeCursor + 1 <= slicedLine.length ? slicedLine.substring(relativeCursor + 1) : "";

    return (
      <Box key={absoluteIndex}>
        {leftIndicator && <Text color="gray">…</Text>}
        <Text>{beforeCursor}</Text>
        <Text backgroundColor="white" color="black">{cursorChar}</Text>
        <Text>{afterCursor}</Text>
        {rightIndicator && <Text color="gray">…</Text>}
      </Box>
    );
  };

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1} paddingY={0}>
      {label && <Text color="white" bold>{label}</Text>}

      {startLine > 0 && (
        <Text color="gray" dimColor>
          ↑ {startLine} line{startLine > 1 ? "s" : ""} above • Ctrl+Arrows: skip words
        </Text>
      )}

      <Box flexDirection="column" minHeight={Math.min(maxHeight, totalLines)}>
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
        Shift+Enter: newline • Enter: submit • Ctrl+A/E: line start/end
      </Text>
    </Box>
  );
};
