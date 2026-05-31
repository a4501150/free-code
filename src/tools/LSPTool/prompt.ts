export const LSP_TOOL_NAME = 'LSP' as const

export const DESCRIPTION = `Interact with Language Server Protocol (LSP) servers to get code intelligence features.

Supported operations:
- goToDefinition: Find where a symbol is defined
- findReferences: Find all references to a symbol
- hover: Get hover information (documentation, type info) for a symbol
- documentSymbol: Get all symbols (functions, classes, variables) in a document
- workspaceSymbol: Search for symbols across the entire workspace
- goToImplementation: Find implementations of an interface or abstract method
- prepareCallHierarchy: Get call hierarchy item at a position (functions/methods)
- incomingCalls: Find all functions/methods that call the function at a position
- outgoingCalls: Find all functions/methods called by the function at a position

All operations require \`filePath\`. It selects the document or the workspace's LSP server.

Position-based operations also require \`line\` and \`character\` (both 1-based):
- goToDefinition
- findReferences
- hover
- goToImplementation
- prepareCallHierarchy
- incomingCalls
- outgoingCalls

\`documentSymbol\` requires only \`filePath\`.
\`workspaceSymbol\` accepts an optional \`query\`; omit it to request all symbols.

Note: LSP servers must be configured for the file type. If no server is available, an error will be returned.`
