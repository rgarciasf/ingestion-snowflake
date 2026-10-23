-- 06_commitments_claude.sql: Claude in Cortex reads every customer meeting transcript, extracts each
-- promise Acme made (owner, due date, quote), checks the later follow-up notes for status,
-- and writes the result to ACME.BRAIN.COMMITMENTS with a citation back to the transcript chunk.
-- Re-runnable: replaces the extracted rows each time.

USE ROLE ACCOUNTADMIN;
USE WAREHOUSE ACME_WH;

-- Pick a Claude model available in your region/account (SHOW MODELS / docs: "Cortex AI models").
SET CLAUDE_MODEL = 'claude-sonnet-4-5';

CREATE OR REPLACE TEMPORARY TABLE ACME.BRAIN._EXTRACTED AS
WITH followups AS (
  SELECT LISTAGG('### ' || TITLE || ' (' || UPDATED_ON || ')\n' || CONTENT, '\n\n') AS notes
  FROM ACME.KNOWLEDGE.DOCUMENTS
  WHERE SOURCE_TYPE = 'meetings' AND ACCOUNT IS NULL AND TITLE ILIKE '%customer success%'
)
SELECT
  d.DOC_ID, d.ACCOUNT, d.UPDATED_ON AS MEETING_DATE,
  AI_COMPLETE(
    model => $CLAUDE_MODEL,
    prompt => 'You are extracting commitments from a customer call at Acme (a B2B analytics SaaS).\n'
      || 'A commitment is a concrete promise an Acme employee made to the customer (send, schedule, fix, set up, confirm...).\n'
      || 'Ignore promises made by the customer. Resolve relative dates against the meeting date ' || d.UPDATED_ON || '.\n'
      || 'Then use the FOLLOW-UP NOTES (written later) to set status: "done" if they say it was delivered, '
      || '"open" if they say it is late, pending or not done, "unknown" if they do not mention it. '
      || 'status_evidence must quote or paraphrase the follow-up note, or be empty when unknown.\n\n'
      || '=== MEETING: ' || d.TITLE || ' ===\n' || d.CONTENT
      || '\n\n=== FOLLOW-UP NOTES ===\n' || f.notes,
    model_parameters => {'temperature': 0, 'max_tokens': 4000},
    response_format => {
      'type': 'json',
      'schema': {
        'type': 'object',
        'properties': {
          'commitments': {
            'type': 'array',
            'items': {
              'type': 'object',
              'properties': {
                'owner':           {'type': 'string', 'description': 'Acme person who made the promise'},
                'commitment':      {'type': 'string', 'description': 'What was promised, one sentence'},
                'due_date':        {'type': 'string', 'description': 'YYYY-MM-DD'},
                'timestamp':       {'type': 'string', 'description': 'hh:mm:ss of the transcript line'},
                'quote':           {'type': 'string', 'description': 'Exact words from the transcript'},
                'status':          {'type': 'string', 'enum': ['open', 'done', 'unknown']},
                'status_evidence': {'type': 'string'}
              },
              'required': ['owner', 'commitment', 'due_date', 'timestamp', 'quote', 'status', 'status_evidence']
            }
          }
        },
        'required': ['commitments']
      }
    }
  ) AS RESULT
FROM ACME.KNOWLEDGE.DOCUMENTS d
CROSS JOIN followups f
WHERE d.SOURCE_TYPE = 'meetings' AND d.ACCOUNT IS NOT NULL;

DELETE FROM ACME.BRAIN.COMMITMENTS WHERE EXTRACTED_BY LIKE 'cortex:%';

INSERT INTO ACME.BRAIN.COMMITMENTS
  (DOC_ID, CHUNK_ID, WORKSPACE_ID, ACCOUNT, MEETING_DATE, OWNER, COMMITMENT, DUE_DATE, STATUS, STATUS_EVIDENCE, QUOTE, EXTRACTED_BY)
WITH items AS (
  SELECT x.DOC_ID, x.ACCOUNT, x.MEETING_DATE, c.index AS n, c.value AS item
  FROM ACME.BRAIN._EXTRACTED x,
  LATERAL FLATTEN(input => IFF(IS_OBJECT(x.RESULT), x.RESULT, TRY_PARSE_JSON(x.RESULT::STRING)):commitments) c
)
SELECT
  i.DOC_ID,
  k.CHUNK_ID,                                   -- the transcript window that contains the quote (citation)
  w.WORKSPACE_ID,
  i.ACCOUNT, i.MEETING_DATE,
  i.item:owner::STRING, i.item:commitment::STRING, TRY_TO_DATE(i.item:due_date::STRING),
  i.item:status::STRING, NULLIF(i.item:status_evidence::STRING, ''), i.item:quote::STRING,
  'cortex:' || $CLAUDE_MODEL
FROM items i
LEFT JOIN ACME.KNOWLEDGE.DOC_CHUNKS k
  ON k.DOC_ID = i.DOC_ID AND k.TRANSCRIPT_TS <= i.item:timestamp::STRING
LEFT JOIN ACME.PULSE.WORKSPACES w ON w.NAME = i.ACCOUNT
QUALIFY ROW_NUMBER() OVER (PARTITION BY i.DOC_ID, i.n ORDER BY k.TRANSCRIPT_TS DESC NULLS LAST) = 1;

SELECT ACCOUNT, OWNER, COMMITMENT, DUE_DATE, STATUS, IFF(STATUS <> 'done' AND DUE_DATE < '2026-10-22', 'OVERDUE', '') AS FLAG
FROM ACME.BRAIN.COMMITMENTS ORDER BY ACCOUNT, DUE_DATE;
