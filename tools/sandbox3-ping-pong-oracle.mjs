// A ping-pong acceptance test proves that this task got a real answer. Task,
// Runner and delivery IDs are validated separately; the model need not obey an
// exact-output formatting request for the system path to be healthy.
export function pingPongAnswerPresent(resultText) {
  if (typeof resultText !== 'string') return false;

  const answer = resultText.trim();
  if (!answer) return false;

  // The task delivery path renders these explicit terminal failures as the
  // user-facing answer. Reject those, while allowing verbose or otherwise
  // unconstrained model prose (including discussion of errors).
  return !/^(?:❌\s*)?(?:задача завершилась ошибкой(?:\.|$)|ошибка исполнителя(?:\.|\s*:|$)|ошибка настройки исполнителя\b)/iu.test(answer);
}
