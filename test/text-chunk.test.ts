import { chunkText } from "../src/domain/text-chunk";

describe("text chunking", () => {
  it("prefers a nearby word boundary and resumes without splitting a word", () => {
    const value = "alpha beta gamma delta epsilon";
    const first = chunkText(value, 0, 17);
    expect(first).toEqual({ body: "alpha beta gamma ", nextOffset: 17 });
    expect(chunkText(value, first.nextOffset ?? 0, 17).body).toBe("delta epsilon");
  });

  it("falls back to code-point boundaries for a long unbroken token", () => {
    expect(chunkText("😀😀😀😀😀", 0, 3)).toEqual({ body: "😀😀😀", nextOffset: 3 });
  });
});
