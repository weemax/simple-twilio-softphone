// CRA + React 18: enable `act` support in the JSDOM test environment.
// Without this flag, react-dom warns "The current testing environment
// is not configured to support act(...)" and the warnings leak into
// the test output.
global.IS_REACT_ACT_ENVIRONMENT = true;
