/* ── Convert hex color (#rrggbb) to ASS BGR format ── */
function hexToAss(hex) {
  const h = hex.replace("#", "");
  const r = h.slice(0, 2);
  const g = h.slice(2, 4);
  const b = h.slice(4, 6);
  return `&H00${b}${g}${r}&`.toUpperCase();
}

/* ── ASS alignment: bottom=2, center=5, top=8 ── */
const POSITION_MAP = { bottom: 2, center: 5, top: 8 };

const THEMES = {
  classic: {
    subtitleColor: "&HFFFFFF&",
    fontSize: 11,
    bold: 1,
    outline: 1.5,
    shadow: 0.5,
    marginV: 27,
    alignment: 2,
    transition: "fade",
  },
  neon: {
    subtitleColor: "&H00FFFF&",
    fontSize: 12,
    bold: 1,
    outline: 1,
    shadow: 0,
    marginV: 27,
    alignment: 2,
    transition: "slideleft",
  },
  fire: {
    subtitleColor: "&H00FFFF&",
    fontSize: 13,
    bold: 1,
    outline: 2,
    shadow: 1,
    marginV: 27,
    alignment: 2,
    transition: "zoomin",
  },
  minimal: {
    subtitleColor: "&HEBEBEB&",
    fontSize: 9,
    bold: 0,
    outline: 1,
    shadow: 0,
    marginV: 27,
    alignment: 2,
    transition: "fade",
  },
  bold: {
    subtitleColor: "&HCC99FF&",
    fontSize: 15,
    bold: 1,
    outline: 2.5,
    shadow: 1,
    marginV: 27,
    alignment: 5,
    transition: "wipeleft",
  },
};

/* Build the final theme object from request body */
function resolveTheme(themeId, themeSettings) {
  const baseTheme = THEMES[themeId] || THEMES.classic;
  if (!themeSettings) return baseTheme;
  return {
    subtitleColor: hexToAss(themeSettings.subtitleColor || "#ffffff"),
    fontSize: themeSettings.fontSize ?? baseTheme.fontSize,
    bold: themeSettings.bold ? 1 : 0,
    outline: themeSettings.outline ?? baseTheme.outline,
    shadow: themeSettings.shadow ?? baseTheme.shadow,
    marginV:
      themeSettings.position === "center"
        ? 0
        : themeSettings.position === "top"
        ? 40
        : 27,
    alignment: POSITION_MAP[themeSettings.position] ?? baseTheme.alignment,
    transition: themeSettings.transition || baseTheme.transition,
  };
}

module.exports = { THEMES, POSITION_MAP, hexToAss, resolveTheme };
