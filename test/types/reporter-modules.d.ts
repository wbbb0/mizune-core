declare module "../reporters/failures-summary.mjs" {
  const failuresSummaryReporter: (source: AsyncIterable<any>) => AsyncIterable<string>;
  export default failuresSummaryReporter;
}
