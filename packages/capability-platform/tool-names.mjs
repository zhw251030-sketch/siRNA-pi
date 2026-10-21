// Keep admission separate from the historically hashed official-tool catalog.
// Reserve only this newly introduced control name; normalize one MCP alias.
export const isReservedToolName=name=>typeof name==='string'&&name.replace(/^sirna_tools_/,'')==='report_tool_gap';
