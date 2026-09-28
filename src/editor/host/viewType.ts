/**
 * The Visual Editor's custom editor view type: registered by `provider.ts`,
 * and read by `session.ts` to tell whether a link it followed opened in the
 * Visual Editor. Its own module, so neither imports the other for it.
 */
export const VISUAL_EDITOR_VIEW_TYPE = 'markdownExtended.visualEditor';
