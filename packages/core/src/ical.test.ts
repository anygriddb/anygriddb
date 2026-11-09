import { describe, expect, it } from "vitest";
import { buildICalendar, escapeICalText, foldICalLine } from "./ical";

describe("iCalendar", () => {
  it("escapes text and folds long lines on character boundaries", () => {
    expect(escapeICalText("a;b,c\\d\ne")).toBe("a\\;b\\,c\\\\d\\ne");
    const folded = foldICalLine(`SUMMARY:${"é".repeat(60)}`);
    const lines = folded.split("\r\n");
    expect(lines.length).toBe(2);
    for (const line of lines) {
      expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(75);
    }
    expect(lines[1]?.startsWith(" ")).toBe(true);
    expect(
      lines.map((line, index) => (index ? line.slice(1) : line)).join(""),
    ).toBe(`SUMMARY:${"é".repeat(60)}`);
  });

  it("writes days with an exclusive end, and times in UTC", () => {
    const text = buildICalendar({
      name: "Réunions, équipe",
      now: new Date("2026-11-08T12:00:00Z"),
      events: [
        {
          uid: "1@ag.example",
          summary: "Inventaire; dépôt",
          start: { date: "2026-02-28" },
          end: { date: "2026-03-01" },
          url: "https://ag.example/b/x/t/y?row=1",
        },
        {
          uid: "2@ag.example",
          summary: "Appel",
          start: { instant: "2026-01-10T09:30:00.25+00:00" },
        },
        { uid: "3@ag.example", summary: "Sans date", start: { instant: "x" } },
      ],
    });
    expect(text.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(text).not.toMatch(/[^\r]\n/);
    expect(text).toContain("X-WR-CALNAME:Réunions\\, équipe");
    expect(text).toContain(
      "DTSTART;VALUE=DATE:20260228\r\nDTEND;VALUE=DATE:20260302",
    );
    expect(text).toContain("SUMMARY:Inventaire\\; dépôt");
    expect(text).toContain(
      "DTSTART:20260110T093000Z\r\nDTEND:20260110T103000Z",
    );
    expect(text).toContain("DTSTAMP:20261108T120000Z");
    expect(text).not.toContain("Sans date");
    expect(text.match(/BEGIN:VEVENT/g)).toHaveLength(2);
  });
});
