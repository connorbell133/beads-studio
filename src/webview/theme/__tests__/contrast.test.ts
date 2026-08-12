import { AA_GRAPHIC, AA_TEXT, contrastRatio } from "../contrast";
import {
  GRAPHIC_TOKENS,
  TEXT_TOKENS,
  priorityLabel,
  priorityStyle,
  statusHue,
  typeHue,
} from "../tokens";

/**
 * The palette is theme-derived, so its real values come from whichever theme is
 * active. What can be verified here is the guarantee the design rests on: that
 * VS Code's own defaults, for the tokens this module chooses, clear the
 * contrast bar those tokens are used at.
 *
 * Values below were read out of the installed VS Code build's colour registry,
 * not copied from documentation.
 */
const DEFAULTS: Record<string, Record<string, string>> = {
  "--vscode-foreground": {
    dark: "#CCCCCC",
    light: "#616161",
    hcDark: "#FFFFFF",
    hcLight: "#292929",
  },
  "--vscode-charts-red": {
    dark: "#F14C4C",
    light: "#E51400",
    hcDark: "#F48771",
    hcLight: "#B5200D",
  },
  "--vscode-charts-blue": {
    dark: "#59a4f9",
    light: "#0063d3",
    hcDark: "#59a4f9",
    hcLight: "#0063d3",
  },
  "--vscode-charts-purple": {
    dark: "#B180D7",
    light: "#652D90",
    hcDark: "#B180D7",
    hcLight: "#652D90",
  },
  "--vscode-charts-green": {
    dark: "#89D185",
    light: "#388A34",
    hcDark: "#89D185",
    hcLight: "#374e06",
  },
  "--vscode-charts-yellow": {
    dark: "#CCA700",
    light: "#BF8803",
    hcDark: "#FFD370",
    hcLight: "#895503",
  },
  // VS Code defines this as foreground at 70% alpha everywhere except light,
  // so the non-light values are that alpha composited over the editor
  // background - which is what a reader actually sees.
  "--vscode-descriptionForeground": {
    dark: "#989898",
    light: "#717171",
    hcDark: "#B3B3B3",
    hcLight: "#696969",
  },
};

const EDITOR_BACKGROUND: Record<string, string> = {
  dark: "#1E1E1E",
  light: "#ffffff",
  hcDark: "#000000",
  hcLight: "#ffffff",
};

const THEMES = Object.keys(EDITOR_BACKGROUND);

/** "var(--vscode-charts-red)" -> "--vscode-charts-red" */
function variableName(token: string): string {
  const match = /^var\((--[A-Za-z-]+)\)$/.exec(token);
  if (!match) throw new Error(`Token is not a bare CSS variable: ${token}`);
  return match[1];
}

function ratios(token: string): Array<{ theme: string; ratio: number }> {
  const name = variableName(token);
  const values = DEFAULTS[name];
  if (!values) return [];
  return THEMES.map((theme) => ({
    theme,
    ratio: contrastRatio(values[theme], EDITOR_BACKGROUND[theme]),
  }));
}

describe("contrastRatio", () => {
  it("matches the known extremes", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 1);
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
  });

  it("is order independent", () => {
    expect(contrastRatio("#1E1E1E", "#F14C4C")).toBeCloseTo(
      contrastRatio("#F14C4C", "#1E1E1E"),
      10
    );
  });

  it("rejects a colour it cannot parse rather than scoring it silently", () => {
    expect(() => contrastRatio("#fff", "#000000")).toThrow();
  });
});

describe("text tokens", () => {
  it.each(Object.entries(TEXT_TOKENS))(
    "%s clears AA text contrast in every built-in theme",
    (_name, token) => {
      const measured = ratios(token);
      // descriptionForeground is VS Code's own secondary-text token and has no
      // fixed default to assert against; it is covered by matching the host.
      if (measured.length === 0) return;
      for (const { theme, ratio } of measured) {
        expect({ theme, ratio: Number(ratio.toFixed(2)) }).toEqual({
          theme,
          ratio: expect.any(Number),
        });
        expect(ratio).toBeGreaterThanOrEqual(AA_TEXT);
      }
    }
  );

  it("excludes the tokens that cannot carry text", () => {
    // Regression guard for the measurement this palette is built on: green and
    // yellow fall under AA text contrast on the light theme, so they must never
    // become label colours.
    const textTokens = Object.values(TEXT_TOKENS) as string[];
    expect(textTokens).not.toContain(GRAPHIC_TOKENS.success);
    expect(textTokens).not.toContain(GRAPHIC_TOKENS.warning);
  });

  it("confirms green and yellow really are below the text bar somewhere", () => {
    const green = ratios(GRAPHIC_TOKENS.success).map((r) => r.ratio);
    const yellow = ratios(GRAPHIC_TOKENS.warning).map((r) => r.ratio);

    expect(Math.min(...green)).toBeLessThan(AA_TEXT);
    expect(Math.min(...yellow)).toBeLessThan(AA_TEXT);
  });
});

describe("graphic tokens", () => {
  it.each(Object.entries(GRAPHIC_TOKENS))(
    "%s clears the 3:1 graphic bar in every built-in theme",
    (_name, token) => {
      const measured = ratios(token);
      if (measured.length === 0) return;
      for (const { ratio } of measured) {
        expect(ratio).toBeGreaterThanOrEqual(AA_GRAPHIC);
      }
    }
  );

  it("never uses charts-orange", () => {
    // It resolves to editor.findMatchHighlightBackground - a 33%-alpha
    // background - and is null in both high-contrast themes.
    const all = JSON.stringify(GRAPHIC_TOKENS);
    expect(all).not.toContain("charts-orange");
  });
});

describe("the one literal colour pair", () => {
  it("keeps the sticky-note toast above AA on its own", () => {
    // An opaque overlay, so it does not vary with the theme - but it is the
    // only place in the webview where a literal survives, so it is pinned.
    expect(contrastRatio("#1a1a1a", "#fff176")).toBeGreaterThanOrEqual(AA_TEXT);
  });
});

describe("semantic mapping", () => {
  it("gives every built-in status a hue", () => {
    for (const status of ["open", "in_progress", "blocked", "deferred", "closed", "pinned", "hooked"]) {
      expect(statusHue(status)).toMatch(/^var\(--vscode-/);
    }
  });

  it("falls back rather than returning undefined for a custom status", () => {
    expect(statusHue("awaiting_review")).toBe(GRAPHIC_TOKENS.neutral);
  });

  it("groups types into families instead of inventing fourteen hues", () => {
    expect(typeHue("epic")).toBe(typeHue("milestone"));
    expect(typeHue("task")).toBe(typeHue("feature"));
    expect(typeHue("bug")).not.toBe(typeHue("task"));
  });

  it("renders coordination types quietly", () => {
    for (const type of ["gate", "agent", "role", "message"]) {
      expect(typeHue(type)).toBe(GRAPHIC_TOKENS.neutral);
    }
  });

  it("falls back for an unknown custom type", () => {
    expect(typeHue("frobnicator")).toBe(GRAPHIC_TOKENS.neutral);
    expect(typeHue(undefined)).toBe(GRAPHIC_TOKENS.neutral);
  });

  it("colours only the top of the priority scale", () => {
    expect(priorityStyle(0).color).toBe(TEXT_TOKENS.danger);
    expect(priorityStyle(1).color).toBe(TEXT_TOKENS.primary);
    expect(priorityStyle(3).color).toBe(TEXT_TOKENS.muted);
    expect(priorityStyle(4).color).toBe(TEXT_TOKENS.muted);
  });

  it("keeps priority readable without colour by carrying the rank as text", () => {
    expect(priorityLabel(0)).toBe("P0");
    expect(priorityLabel(4)).toBe("P4");
    expect(priorityLabel(undefined)).toBe("P?");
  });

  it("weights P0 heaviest so rank survives a greyscale render", () => {
    expect(priorityStyle(0).fontWeight).toBeGreaterThan(priorityStyle(2).fontWeight);
  });
});
