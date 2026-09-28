// A composition root is where collaborators are built and configuration is read,
// so rules about constructing or configuring inside business logic skip it. The
// convention every one of these follows is an index file at any depth.
export const defaultCompositionRootPattern = '(^|/)index\\.[cm]?[jt]sx?$'
