-- HR version · 14_hr_commitments_claude.sql: Claude in Cortex reads HR notes (1:1s, retros, staffing reviews),
-- extracts every promise made to an employee or team, checks the People Team follow-up notes for status,
-- and writes ACME.BRAIN.PEOPLE_COMMITMENTS with a citation back to the note.

USE ROLE ACCOUNTADMIN;
USE WAREHOUSE ACME_WH;

-- Same model as 06_commitments_claude.sql; pick one available in your Snowflake region.
SET CLAUDE_MODEL = 'claude-sonnet-4-5';

CREATE OR REPLACE TEMPORARY TABLE ACME.BRAIN._HR_EXTRACTED AS
WITH followups AS (
  SELECT LISTAGG('### ' || TITLE || ' (' || UPDATED_ON || ')\n' || CONTENT, '\n\n') AS notes
  FROM ACME.KNOWLEDGE.DOCUMENTS
  WHERE SOURCE_TYPE = 'people' AND TEAM IS NULL AND TITLE ILIKE '%people team weekly%'
)
SELECT
  d.DOC_ID, d.TEAM, d.UPDATED_ON AS MEETING_DATE,
  AI_COMPLETE(
    model => $CLAUDE_MODEL,
    prompt => 'You are extracting promises made to employees at Acme from an internal HR note.\n'
      || 'A promise is a concrete commitment by a manager or HR person to an employee or a team (promotion case, compensation review, '
      || 'comp days / time off, staffing or hiring, on-call changes, budget, stay interview...). Ignore things employees say they will do.\n'
      || 'promised_to is the named employee, or "team" if made to the whole team. category is one of: workload, recovery, career, pay, staffing, other.\n'
      || 'Resolve relative dates against the note date ' || d.UPDATED_ON || '; if a promise has no date, use the most reasonable date stated nearby.\n'
      || 'Then use the FOLLOW-UP NOTES (written later) to set status: "done" if delivered; "broken" ONLY if the follow-up says the promise was '
      || 'violated or can no longer be kept (e.g. the team worked the weekend it was promised off, or a deadline was missed and pushed to a later cycle); '
      || '"open" if it is late, pending or not started yet; "unknown" if the follow-up does not mention it. '
      || 'status_evidence quotes or paraphrases the follow-up note, or is empty.\n\n'
      || '=== NOTE: ' || d.TITLE || ' ===\n' || d.CONTENT
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
                'owner':           {'type': 'string'},
                'promised_to':     {'type': 'string'},
                'commitment':      {'type': 'string'},
                'category':        {'type': 'string', 'enum': ['workload', 'recovery', 'career', 'pay', 'staffing', 'other']},
                'due_date':        {'type': 'string', 'description': 'YYYY-MM-DD'},
                'timestamp':       {'type': 'string', 'description': 'hh:mm:ss of the line, or empty'},
                'quote':           {'type': 'string'},
                'status':          {'type': 'string', 'enum': ['open', 'done', 'broken', 'unknown']},
                'status_evidence': {'type': 'string'}
              },
              'required': ['owner', 'promised_to', 'commitment', 'category', 'due_date', 'timestamp', 'quote', 'status', 'status_evidence']
            }
          }
        },
        'required': ['commitments']
      }
    }
  ) AS RESULT
FROM ACME.KNOWLEDGE.DOCUMENTS d
CROSS JOIN followups f
WHERE d.SOURCE_TYPE = 'people' AND d.TEAM IS NOT NULL;

DELETE FROM ACME.BRAIN.PEOPLE_COMMITMENTS WHERE EXTRACTED_BY LIKE 'cortex:%';

INSERT INTO ACME.BRAIN.PEOPLE_COMMITMENTS
  (DOC_ID, CHUNK_ID, TEAM, PROMISED_TO, MEETING_DATE, OWNER, COMMITMENT, CATEGORY, DUE_DATE, STATUS, STATUS_EVIDENCE, QUOTE, EXTRACTED_BY)
WITH items AS (
  SELECT x.DOC_ID, x.TEAM, x.MEETING_DATE, c.index AS n, c.value AS item
  FROM ACME.BRAIN._HR_EXTRACTED x,
  LATERAL FLATTEN(input => IFF(IS_OBJECT(x.RESULT), x.RESULT, TRY_PARSE_JSON(x.RESULT::STRING)):commitments) c
)
SELECT
  i.DOC_ID,
  k.CHUNK_ID,
  i.TEAM, i.item:promised_to::STRING, i.MEETING_DATE,
  i.item:owner::STRING, i.item:commitment::STRING, i.item:category::STRING, TRY_TO_DATE(i.item:due_date::STRING),
  i.item:status::STRING, NULLIF(i.item:status_evidence::STRING, ''), i.item:quote::STRING,
  'cortex:' || $CLAUDE_MODEL
FROM items i
LEFT JOIN ACME.KNOWLEDGE.DOC_CHUNKS k
  ON k.DOC_ID = i.DOC_ID AND (k.TRANSCRIPT_TS <= NULLIF(i.item:timestamp::STRING, '') OR k.CHUNK_INDEX = 0)
QUALIFY ROW_NUMBER() OVER (PARTITION BY i.DOC_ID, i.n ORDER BY k.TRANSCRIPT_TS DESC NULLS LAST) = 1;

SELECT TEAM, PROMISED_TO, OWNER, COMMITMENT, CATEGORY, DUE_DATE, STATUS,
  IFF(STATUS <> 'done' AND DUE_DATE < '2026-10-22', 'OVERDUE', '') AS FLAG
FROM ACME.BRAIN.PEOPLE_COMMITMENTS ORDER BY TEAM, DUE_DATE;
