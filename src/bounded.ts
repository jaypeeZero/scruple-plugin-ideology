export interface BoundedText {
  text: string
  truncated: boolean
}

export const boundedText = (value: string, max: number): BoundedText => {
  if (value.length <= max) return { text: value, truncated: false }

  const half = Math.floor(max / 2)
  return {
    text: `${value.slice(0, half)}\n/* … bounded evidence omitted … */\n${value.slice(-half)}`,
    truncated: true
  }
}
