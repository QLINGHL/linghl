/** Accept model-produced TeX delimiters while preserving fenced and inline code. */
export function normalizeMath(text: string): string {
  const code = /(^ {0,3}(\x60{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\2[ \t]*$|(?![\s\S])))|(\x60+)[\s\S]*?\3/gm;
  const convert = (value: string) => value
    .replace(/(?<!\\)\\\[([\s\S]*?)\\\]/g, (_, body: string) => "\n$$\n" + body.trim() + "\n$$\n")
    .replace(/(?<!\\)\\\(([^\n]*?)\\\)/g, (_, body: string) => "$" + body.trim() + "$");
  let result = "";
  let start = 0;
  for (const match of text.matchAll(code)) {
    result += convert(text.slice(start, match.index)) + match[0];
    start = match.index! + match[0].length;
  }
  return result + convert(text.slice(start));
}
