export interface RestorePromotionState {
  candidateReady: boolean;
  parsedSequence: number;
  latestSequence: number;
  restoreMatches: boolean;
  composing: boolean;
  inputFocused: boolean;
}

export function canPromoteTerminalRestore(state: RestorePromotionState): boolean {
  return (
    state.candidateReady &&
    state.parsedSequence >= state.latestSequence &&
    state.restoreMatches &&
    !state.composing &&
    !state.inputFocused
  );
}

export function translatePreviewBottomOffset(
  storedBottomOffset: number,
  previewBottomOffset: number,
  currentPreviewBottomOffset: number,
  maximum: number,
): number {
  return Math.min(
    maximum,
    Math.max(0, Math.round(storedBottomOffset + currentPreviewBottomOffset - previewBottomOffset)),
  );
}
