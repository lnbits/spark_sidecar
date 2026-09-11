export async function resolve(specifier, context, nextResolve) {
  if (
    specifier === '@buildonspark/spark-sdk' &&
    context.parentURL?.endsWith('/server.mjs')
  )
    return {
      url: new URL('./fixture-sdk.mjs', import.meta.url).href,
      shortCircuit: true
    }
  return nextResolve(specifier, context)
}
