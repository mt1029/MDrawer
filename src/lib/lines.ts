/** offset 在第幾行（從 0 起算）：offset 之前有幾個換行 */
export function lineAt(text: string, offset: number): number {
  let line = 0
  for (let i = text.indexOf('\n'); i !== -1 && i < offset; i = text.indexOf('\n', i + 1)) line++
  return line
}
