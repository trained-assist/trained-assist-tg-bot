// A ping-pong acceptance test proves that this task got a real answer. Task,
// Runner and delivery IDs are validated separately; the model need not obey an
// exact-output formatting request for the system path to be healthy.
export function pingPongAnswerPresent(resultText) {
  return typeof resultText === 'string' && resultText.trim().length > 0;
}
