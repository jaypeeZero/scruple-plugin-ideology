// Test files and their doubles (fakes, mocks, stubs) are callers, so no ideology rule
// scopes them. Matching is by filename suffix, the convention every one of these follows.
export const defaultTestFilePattern = '(\\.(spec|test)|[Ff]akes?|[Dd]oubles?|[Mm]ocks?|[Ss]tubs?)\\.[cm]?[jt]sx?$'
