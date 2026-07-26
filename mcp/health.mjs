export class JournalHealth {
  constructor(version) {
    this.version = version
    this.startedAt = Date.now()
    this.ready = false
    this.mcpRequests = 0
    this.toolCalls = 0
    this.toolFailures = 0
    this.resourceReads = 0
  }

  snapshot(state = 'healthy') {
    return {
      service: 'Journal MCP',
      version: this.version,
      state,
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
    }
  }

  metrics() {
    return [
      '# HELP journal_mcp_ready Whether Journal MCP is ready',
      '# TYPE journal_mcp_ready gauge',
      `journal_mcp_ready ${this.ready ? 1 : 0}`,
      '# TYPE journal_mcp_requests_total counter',
      `journal_mcp_requests_total ${this.mcpRequests}`,
      '# TYPE journal_mcp_tool_calls_total counter',
      `journal_mcp_tool_calls_total ${this.toolCalls}`,
      '# TYPE journal_mcp_tool_failures_total counter',
      `journal_mcp_tool_failures_total ${this.toolFailures}`,
      '# TYPE journal_mcp_resource_reads_total counter',
      `journal_mcp_resource_reads_total ${this.resourceReads}`,
      '',
    ].join('\n')
  }
}
