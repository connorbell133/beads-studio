import { formatMinutes } from "../duration";

describe("formatMinutes", () => {
  it("writes minutes alone below an hour", () => {
    expect(formatMinutes(45)).toBe("45m");
    expect(formatMinutes(1)).toBe("1m");
  });

  it("drops the minutes when there are none", () => {
    expect(formatMinutes(120)).toBe("2h");
  });

  it("writes both when there are both", () => {
    expect(formatMinutes(150)).toBe("2h 30m");
  });

  it("never prints a leading zero hour", () => {
    // "0h 45m" is what every call site wrote by hand before this existed.
    expect(formatMinutes(45)).not.toContain("0h");
  });

  it("keeps zero as a duration rather than an absence", () => {
    // The caller decides whether to show it at all; this only formats.
    expect(formatMinutes(0)).toBe("0m");
  });

  it("rounds a fractional minute rather than printing it", () => {
    expect(formatMinutes(90.4)).toBe("1h 30m");
    expect(formatMinutes(90.6)).toBe("1h 31m");
  });

  it("refuses to render bad data as a duration", () => {
    expect(formatMinutes(-30)).toBe("—");
    expect(formatMinutes(NaN)).toBe("—");
    expect(formatMinutes(Infinity)).toBe("—");
  });
});
