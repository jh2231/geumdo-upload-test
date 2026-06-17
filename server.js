// 금도건설 품질실 — 업로드 한계 테스트용 최소 MCP 서버
// 역할: Claude(개인 계정)가 이 서버의 "upload_report" 도구를 호출하면
//      base64로 인코딩된 파일을 받아 저장하고, 받은 용량을 그대로 알려준다.
// 목적: "개인 클로드 → 보고서 작성 → 자동 업로드"가 실제로 어디까지 되는지
//      (몇 MB까지 안정적인지) 가장 단순한 형태로 먼저 확인하기 위함.

import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { google } from 'googleapis';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

// 구글 드라이브 업로드용 — OAuth(실제 계정) 인증.
// (서비스 계정 방식은 "Service Accounts do not have storage quota" 오류로 일반 개인
//  드라이브 폴더에는 쓸 수 없음이 확인됨 — 무료/개인 Gmail 계정에서는 OAuth가 유일한 방법)
// 클라이언트ID/시크릿/refresh token 모두 코드에 포함하지 않음. Render 환경변수로만 주입.
function getDriveClient() {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      'GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET / GOOGLE_OAUTH_REFRESH_TOKEN ' +
        '환경변수가 모두 설정되어 있어야 합니다.'
    );
  }
  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
  oauth2Client.setCredentials({ refresh_token: refreshToken });
  return google.drive({ version: 'v3', auth: oauth2Client });
}

const app = express();

// 받는 쪽 한도는 넉넉하게 열어둔다.
// (이 테스트의 진짜 한계는 서버 용량이 아니라 "Claude가 base64를 한 번에
//  얼마나 길게 만들어낼 수 있는가"이기 때문 — 서버가 먼저 막히면 안 됨)
app.use(express.json({ limit: '100mb' }));

const UPLOAD_DIR = path.join(process.cwd(), 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

app.post('/mcp', async (req, res) => {
  try {
    const server = new McpServer({ name: 'geumdo-upload-test', version: '1.0.0' });

    server.tool(
      'upload_report',
      '테스트용 도구. 보고서 파일을 base64로 받아 서버에 저장하고, 수신한 용량(byte/MB)을 알려준다. ' +
        '업로드가 어디까지 가능한지 확인하는 용도이며, 실제 운영용 저장소는 아니다.',
      {
        filename: z.string().describe('저장할 파일명 (예: 점검자_26.06.17_테스트.pptx)'),
        base64Content: z.string().describe('파일 전체 바이트를 base64로 인코딩한 문자열'),
      },
      async ({ filename, base64Content }) => {
        const buffer = Buffer.from(base64Content, 'base64');
        const sizeMB = (buffer.length / 1024 / 1024).toFixed(2);
        const safeName = `${Date.now()}_${filename.replace(/[/\\]/g, '_')}`;
        const savedPath = path.join(UPLOAD_DIR, safeName);
        fs.writeFileSync(savedPath, buffer);

        console.log(`[upload] ${filename} -> ${buffer.length} bytes (${sizeMB} MB)`);

        return {
          content: [
            {
              type: 'text',
              text:
                `업로드 성공\n` +
                `- 파일명: ${filename}\n` +
                `- 수신 용량: ${buffer.length.toLocaleString()} bytes (${sizeMB} MB)\n` +
                `- 저장 위치(서버 임시저장): ${safeName}`,
            },
          ],
        };
      }
    );

    server.tool(
      'upload_to_drive',
      '서비스 계정 인증으로 base64 파일을 구글 드라이브의 지정된 폴더에 직접 업로드한다. ' +
        'folderId는 드라이브 폴더 URL의 마지막 부분(.../folders/ 뒤 문자열)을 그대로 넣으면 된다. ' +
        '대상 폴더는 사전에 서비스 계정 이메일과 "편집자" 권한으로 공유되어 있어야 한다.',
      {
        filename: z.string().describe('드라이브에 저장할 파일명 (예: 점검자_26.06.17_검토보고서.pptx)'),
        base64Content: z.string().describe('파일 전체 바이트를 base64로 인코딩한 문자열'),
        folderId: z.string().describe('업로드할 구글 드라이브 폴더 ID'),
        mimeType: z
          .string()
          .optional()
          .describe('파일 MIME 타입 (예: application/vnd.openxmlformats-officedocument.presentationml.presentation). 생략 시 자동 추정'),
      },
      async ({ filename, base64Content, folderId, mimeType }) => {
        try {
          const buffer = Buffer.from(base64Content, 'base64');
          const sizeMB = (buffer.length / 1024 / 1024).toFixed(2);
          const drive = getDriveClient();

          const res = await drive.files.create({
            requestBody: {
              name: filename,
              parents: [folderId],
            },
            media: {
              mimeType: mimeType || 'application/octet-stream',
              body: Readable.from(buffer),
            },
            fields: 'id, name, webViewLink',
          });

          console.log(`[upload_to_drive] ${filename} -> ${buffer.length} bytes (${sizeMB} MB) -> ${res.data.id}`);

          return {
            content: [
              {
                type: 'text',
                text:
                  `드라이브 업로드 성공\n` +
                  `- 파일명: ${res.data.name}\n` +
                  `- 수신 용량: ${buffer.length.toLocaleString()} bytes (${sizeMB} MB)\n` +
                  `- 파일 ID: ${res.data.id}\n` +
                  `- 링크: ${res.data.webViewLink}`,
              },
            ],
          };
        } catch (err) {
          console.error('[upload_to_drive] 오류:', err);
          const detail =
            err.response?.data?.error_description ||
            (err.response?.data ? JSON.stringify(err.response.data) : null) ||
            err.message ||
            String(err);
          return {
            content: [
              {
                type: 'text',
                text: `드라이브 업로드 실패: ${detail}`,
              },
            ],
            isError: true,
          };
        }
      }
    );

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('MCP 요청 처리 중 오류:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'internal_error', message: String(err) });
    }
  }
});

// MCP 스펙상 GET/DELETE도 응답해줘야 클라이언트가 혼란스러워하지 않음(이 서버는 무상태이므로 둘 다 미지원으로 응답)
app.get('/mcp', (req, res) => {
  res.status(405).set('Allow', 'POST').send('Method Not Allowed');
});
app.delete('/mcp', (req, res) => {
  res.status(405).set('Allow', 'POST').send('Method Not Allowed');
});

// Render가 서비스 살아있는지 확인하거나, 사람이 브라우저로 들어와봤을 때 보일 화면
app.get('/', (req, res) => {
  res.send('OK - 금도건설 업로드 테스트 서버가 정상 동작 중입니다.');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
