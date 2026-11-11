# output-format

category: shared

End your final message with your verdict as a json code block, exactly this shape, `approved` true or false and `notes` with what has to change (empty when approved):

```json
{ "approved": false, "notes": "what to change and where" }
```
