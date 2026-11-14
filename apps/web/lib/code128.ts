/**
 * Code 128 (ISO/IEC 15417), code set B: the printable ASCII characters,
 * which is what a label's text is. A symbol is six runs of one to four
 * modules, bars and spaces in turn, eleven modules in all; the stop is
 * seven runs and thirteen modules.
 */
const PATTERNS = [
  "212222",
  "222122",
  "222221",
  "121223",
  "121322",
  "131222",
  "122213",
  "122312",
  "132212",
  "221213",
  "221312",
  "231212",
  "112232",
  "122132",
  "122231",
  "113222",
  "123122",
  "123221",
  "223211",
  "221132",
  "221231",
  "213212",
  "223112",
  "312131",
  "311222",
  "321122",
  "321221",
  "312212",
  "322112",
  "322211",
  "212123",
  "212321",
  "232121",
  "111323",
  "131123",
  "131321",
  "112313",
  "132113",
  "132311",
  "211313",
  "231113",
  "231311",
  "112133",
  "112331",
  "132131",
  "113123",
  "113321",
  "133121",
  "313121",
  "211331",
  "231131",
  "213113",
  "213311",
  "213131",
  "311123",
  "311321",
  "331121",
  "312113",
  "312311",
  "332111",
  "314111",
  "221411",
  "431111",
  "111224",
  "111422",
  "121124",
  "121421",
  "141122",
  "141221",
  "112214",
  "112412",
  "122114",
  "122411",
  "142112",
  "142211",
  "241211",
  "221114",
  "413111",
  "241112",
  "134111",
  "111242",
  "121142",
  "121241",
  "114212",
  "124112",
  "124211",
  "411212",
  "421112",
  "421211",
  "212141",
  "214121",
  "412121",
  "111143",
  "111341",
  "131141",
  "114113",
  "114311",
  "411113",
  "411311",
  "113141",
  "114131",
  "311141",
  "411131",
  "211412",
  "211214",
  "211232",
] as const;
const STOP = "2331112";
const START_B = 104;
/** What a scanner reads at a glance, and a label holds on one line. */
export const CODE128_MAX_CHARS = 80;

/** The symbol values of a text in code set B, or none when it has a
 * character the set lacks (anything but printable ASCII). */
function valuesOf(text: string): number[] | null {
  const values: number[] = [];
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 32 || code > 126) return null;
    values.push(code - 32);
  }
  return values;
}

/**
 * The modules of a text's barcode, bars as `true`, from the start symbol
 * to the stop, with its check symbol: the start's value plus each
 * symbol's value times its place, modulo 103. None for an empty text, one
 * too long to scan, or one that code set B cannot write. Quiet zones are
 * the drawing's to leave.
 */
export function code128(text: string): boolean[] | null {
  if (text.length === 0 || text.length > CODE128_MAX_CHARS) return null;
  const values = valuesOf(text);
  if (values === null) return null;
  const check =
    values.reduce((sum, value, index) => sum + value * (index + 1), START_B) %
    103;
  const modules: boolean[] = [];
  for (const pattern of [
    PATTERNS[START_B],
    ...values.map((value) => PATTERNS[value]),
    PATTERNS[check],
    STOP,
  ]) {
    if (pattern === undefined) return null;
    for (let run = 0; run < pattern.length; run += 1) {
      const width = Number(pattern[run]);
      for (let module = 0; module < width; module += 1) {
        modules.push(run % 2 === 0);
      }
    }
  }
  return modules;
}
