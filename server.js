// 금도건설 품질실 — 업로드 한계 테스트용 최소 MCP 서버
// 역할: Claude(개인 계정)가 이 서버의 "upload_report" 도구를 호출하면
//      base64로 인코딩된 파일을 받아 저장하고, 받은 용량을 그대로 알려준다.
// 목적: "개인 클로드 → 보고서 작성 → 자동 업로드"가 실제로 어디까지 되는지
//      (몇 MB까지 안정적인지) 가장 단순한 형태로 먼저 확인하기 위함.

import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

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
