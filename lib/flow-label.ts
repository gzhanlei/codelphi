function characterWidth(character: string) {
  return character.codePointAt(0)! > 255 ? 2 : 1;
}

function displayWidth(value: string) {
  return [...value].reduce((width, character) => width + characterWidth(character), 0);
}

export function clipFlowLabel(value: string, limit = 20) {
  if (displayWidth(value) <= limit) return value;
  let result = "";
  for (const character of value) {
    if (displayWidth(result + character) + 1 > limit) break;
    result += character;
  }
  return `${result}…`;
}
