# Shared preamble — every agent prompt inlines these facts

API base   https://app.storyos.dev/api/v1
Workspace  3448c14b-70f3-41bc-9188-839029be9f7e
Auth       Authorization: Bearer $STORYOS_TOKEN   (scope=write, never admin)

Databases
  issues          3f743dcd-d5ca-47c0-a676-72f40934119b
  agents          a4d49921-f925-49c4-88d9-c4c9977ef0af
  uat_scenarios   d11d687e-4b82-451e-943d-5fdbc8fabb8d
  agent_runs      0ff3ade3-2b2a-4f9f-ae11-da8229a420cd
  docs_tasks / website_tasks — resolve once via GET /workspaces/{ws}/databases

Agent record ids (for the `agents` relation filter — note the api_name is
`agents`, not `next`; only the display name was changed)
  Nadia f8bc8f88-0a59-4af3-9834-a8212750ce5d   Kai   04765989-f254-4c31-9584-c09327d3c805
  Vera  3b2a4d86-3e5e-443f-9d5c-c007a01359e9   Mira  9a87aca3-b386-4a65-9261-b3b378bc936b
  Otto  03a29f7f-8418-4a7c-86fa-67c27c49eba8   Iris  730795c7-c443-4523-bd63-bbd85e138fec
  Marek 2c4c1654-d9c0-432f-ac04-93a768525b9a   Ada   78de44d1-4de3-4c72-b75a-ebd57b0e0445
  Lena  31b39c31-e8e0-4a5e-9480-5682772c2da2   Nils  80b50c3d-1c87-4d78-8e46-968c625ba447

Queue query (all agents, same shape)
  POST /workspaces/{ws}/databases/{db}/records/query
  {"filter":{"field":"agents","op":"has","value":["<your agent id>"]},"limit":20}

Step 0 for every run: GET /workspaces/{ws}/databases/{db} once to resolve field
and select-option ids, and cache them for the run. Never hardcode option ids.
