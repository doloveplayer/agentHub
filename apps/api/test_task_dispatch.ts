import WebSocket from 'ws';

const TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiJjN2Q1ZDg0NC1jMjVjLTQwMDItOWMwNy0zYmZjM2ZlYTY0MDMiLCJpYXQiOjE3Nzk1MTI2MjMsImV4cCI6MTc4MDExNzQyM30.o2gk319IbrC3tjyEfWXBmlfzvcXEoU9IGjlgJl8hyQk";
const API = "http://localhost:3000/api";

async function main() {
    // 1. Create group session
    console.log("1. Creating group session...");
    const agentsRes = await fetch(`${API}/agents`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    const agents = await agentsRes.json() as any[];
    const agentIds = agents.map((a: any) => a.id);
    console.log(`   ${agents.length} agents: ${agents.map((a: any) => a.name).join(', ')}`);

    const createRes = await fetch(`${API}/sessions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ type: 'group', agentIds }),
    });
    const session = await createRes.json() as any;
    console.log(`   Session: ${session.id.slice(0, 20)}...`);

    // 2. Send planning request
    console.log("2. Sending planning request...");
    const sendRes = await fetch(`${API}/chat/send`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ sessionId: session.id, content: '@Planner 帮我规划一个计数器网页，就一个任务即可' }),
    });
    const sendData = await sendRes.json() as any;
    const plannerMsgId = sendData.agentMessages[0].agentMessageId;
    console.log(`   Planner msgId: ${plannerMsgId.slice(0, 20)}...`);

    // 3. Connect WS, wait for plan_result
    console.log("3. Waiting for Planner to output plan...");
    const planResult = await new Promise<any>((resolve) => {
        const ws = new WebSocket(`ws://localhost:3000/ws?token=${TOKEN}&sessionId=${session.id}`);
        let planData: any = null;
        ws.on('open', () => {
            ws.send(JSON.stringify({
                type: 'chat', content: '@Planner 帮我规划一个计数器网页，就一个任务即可',
                mentions: [{ agentId: agents.find(a => a.name === 'planner')?.id || '', subPrompt: '帮我规划一个计数器网页，就一个任务即可', messageId: plannerMsgId }],
                trustMode: true,
            }));
        });
        ws.on('message', (raw) => {
            try {
                const d = JSON.parse(raw.toString());
                if (d.type === 'plan_result') { planData = d; }
                if (d.type === 'stream_end') { ws.close(); resolve(planData); }
            } catch {}
        });
        setTimeout(() => { ws.close(); resolve(null); }, 60000);
    });

    if (!planResult) { console.log("   FAILED: No plan_result received"); return; }
    console.log(`   Plan: ${planResult.planTitle} (${planResult.tasks.length} tasks)`);
    planResult.tasks.forEach((t: any) => console.log(`     - ${t.taskId}: ${t.title} [${t.agentType}]`));

    // 4. Confirm plan
    console.log("4. Confirming plan...");
    const done = await new Promise<void>((resolve) => {
        const ws = new WebSocket(`ws://localhost:3000/ws?token=${TOKEN}&sessionId=${session.id}`);
        ws.on('open', () => {
            ws.send(JSON.stringify({ type: 'confirm_plan', planId: planResult.planId, tasks: planResult.tasks }));
        });
        ws.on('message', (raw) => {
            try {
                const d = JSON.parse(raw.toString());
                if (d.type === 'task_assigned') console.log(`   task_assigned: ${d.taskId} → ${d.agentName}`);
                if (d.type === 'task_completed') console.log(`   task_completed: ${d.taskId}`);
                if (d.type === 'task_failed') console.log(`   task_failed: ${d.taskId}`);
                if (d.type === 'stream_chunk') process.stdout.write('.');
                if (d.type === 'stream_end' && d.agentMessageId?.startsWith('task-')) console.log(`\n   task done: ${d.agentMessageId}`);
                if (d.type === 'plan_executing') console.log(`   plan_executing: ${d.planId}`);
            } catch {}
        });
        setTimeout(() => { ws.close(); resolve(); }, 120000);
    });

    console.log("\n5. Done");
}

main().catch(e => console.error(e));
