// Informe SARIF de la fixture de Entrega: una ejecución por revisor, con el
// título de cada regla en su catálogo, como lo produciría cada auditor.
export function sarifFixture(findings) {
  const reviewers = [...new Set(findings.flatMap((f) => f.who))];
  return JSON.stringify({
    version: '2.1.0',
    runs: reviewers.map((name) => {
      const own = findings.filter((f) => f.who.includes(name));
      return {
        tool: { driver: { name, rules: own.map((f) => ({ id: f.id, shortDescription: { text: f.label } })) } },
        results: own.map((f) => ({
          ruleId: f.id, level: f.severity, message: { text: f.label },
          locations: [{ physicalLocation: { artifactLocation: { uri: f.path }, region: { startLine: f.line } } }],
        })),
      };
    }),
  });
}
