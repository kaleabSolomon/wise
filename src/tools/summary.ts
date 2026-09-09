/**
 * Condensing an explanation for somewhere that has no room for it.
 *
 * Shared by the editor hover and the `list_explanations` tool so the two
 * cannot drift into summarising the same prose differently.
 */

/**
 * The opening paragraph of an explanation.
 *
 * A hover has room for a sentence or two; explanations here routinely run to
 * several hundred words, so handing the whole thing to a tooltip would bury
 * the editor. Leading headings are skipped because explanations often open
 * with a title (`## BitReader`) whose text says nothing on its own.
 *
 * The block keeps its own markdown, so a list stays a list rather than being
 * flattened into a run-on line.
 */
export function firstParagraph(prose: string, limit = 320): string {
  const blocks = prose
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);

  const body = blocks.find((block) => !/^#{1,6}\s/.test(block)) ?? blocks[0];
  if (body === undefined) return "";
  if (body.length <= limit) return body;

  // Prefer a word boundary, but never cut back so far that little is left.
  const cut = body.slice(0, limit);
  const space = cut.lastIndexOf(" ");
  return `${(space > limit * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
