
# Testing

## Test the Behavior, Not the Code

A test that verifies a button click produces a confirmation message is testing behavior. A test that verifies a specific internal function was called is testing code. When the implementation changes, behavior tests survive; code tests break.

Write tests at the level of observable outcomes: given this input or action, what does the system produce? Not: given this input, which functions were invoked in which order?

## The Reconstruction Target

A well-tested system should be reconstructable from its test suite alone. If you lost your source code, you could rebuild the application by using the tests as a specification — because every meaningful behavior is described there.

This is the bar. It doesn't mean 100% coverage of every line. It means every behavior the system is supposed to exhibit is captured somewhere in the tests.
