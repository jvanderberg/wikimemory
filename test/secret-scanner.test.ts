import { scanSecrets } from "../src/domain/secret-scanner";

describe("secret scanner", () => {
  it("reports categories and fingerprints without returning the candidate", async () => {
    const fake = "AKIAIOSFODNN7EXAMPLE";
    const findings = await scanSecrets({ body: `Example key: ${fake}` });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ field: "body", category: "aws_access_key" });
    expect(JSON.stringify(findings)).not.toContain(fake);
  });

  it("does not flag ordinary prose", async () => {
    await expect(
      scanSecrets({ body: "A design decision about OAuth and SQLite." })
    ).resolves.toEqual([]);
  });

  it("does not classify long URL paths or media filenames as secrets", async () => {
    const wordpressImage =
      "https://example.org/wp-content/uploads/2026/07/OakParkAssessmentReportA9v3K2m7Q8x1Z6n4P5r0T2w9Y7u3.jpg";
    const report =
      "https://www.rand.org/content/dam/rand/pubs/research_reports/RRA3000/RRA3123-1/RAND_RRA3123-1.pdf";
    await expect(scanSecrets({ body: `${wordpressImage}\n${report}` })).resolves.toEqual([]);
  });

  it("still rejects known provider tokens", async () => {
    const providerToken = "ghp_A1b2C3d4E5f6G7h8I9j0K1l2";
    const findings = await scanSecrets({ body: providerToken });
    expect(findings.map((finding) => finding.category)).toEqual(["provider_token"]);
  });
});
