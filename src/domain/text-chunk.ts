export interface TextChunk {
  body: string;
  nextOffset: number | null;
}

export function chunkText(value: string, offset: number, maximumCharacters: number): TextChunk {
  const characters = Array.from(value);
  const hardEnd = Math.min(characters.length, offset + maximumCharacters);
  let end = hardEnd;
  if (hardEnd < characters.length && maximumCharacters >= 8) {
    const earliestBreak = offset + Math.floor(maximumCharacters * 0.6);
    for (let index = hardEnd - 1; index >= earliestBreak; index -= 1) {
      const character = characters[index];
      if (character !== undefined && /\s/u.test(character)) {
        end = index + 1;
        break;
      }
    }
  }
  return {
    body: characters.slice(offset, end).join(""),
    nextOffset: end < characters.length ? end : null
  };
}
