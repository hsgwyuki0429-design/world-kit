/**
 * The words a disabled control has to contain, in one place, because two things read them.
 *
 * Rule 002 asks that a control which cannot be pressed say *why*, and CAP-0011 checks that it
 * does — by reading the live label off the DOM and looking for the reason in it. So the screen
 * writes these words and the test looks for them, and until now each had its own copy: the
 * screen wrote `LOCKED`, the test searched for `'LOCKED'`, and nothing connected the two except
 * that they happened to match.
 *
 * That held for as long as the interface was in English. Translating the chrome to Japanese
 * broke it in the least visible way available — the screen would have said ロック中, CAP-0011
 * would have looked for `LOCKED`, not found it, and reported that the control *fails to state
 * its reason* while it was stating it perfectly well on the phone. A Phase 0 failure, on the
 * device, caused entirely by a grader hunting for a word nobody displays any more.
 *
 * Hence one definition each. The screen renders it, the test looks for it, and a future change
 * of wording moves both or neither. This is the same reasoning as `describeCarriedPass`: where a
 * sentence is written in one place and checked in another, the two may not keep separate copies.
 *
 * These live in `core` rather than in `ui` because the test kit is the grader and the screen is
 * the graded; a grader that imported from the screen it marks could be handed its own answer.
 */

/** In the label of a control the Phase Lock has closed (Rule 005). */
export const LOCKED_LABEL = 'ロック中';

/** In the label of a control for a phase this build has not implemented. */
export const NOT_IMPLEMENTED_LABEL = '未実装';
