import { afterEach, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { mkdtemp, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { withRetry } from "../lib/fs-retry.js";
import { withFileTransactionLock } from "../lib/storage/file-lock.js";
const dirs: string[] = [], children: ChildProcess[] = [];
afterEach(async () => {
    for (const child of children.splice(0))
        if (child.exitCode === null && child.signalCode === null) {
            const exited = once(child, "exit");
            child.kill("SIGKILL");
            await exited;
        }
    for (const path of dirs.splice(0))
        await withRetry(() => rm(path, { recursive: true, force: true }), { maxAttempts: 6, backoffMs: 25 });
});
async function fixture() {
    const dir = await mkdtemp(join(tmpdir(), "storage-lock-test-"));
    dirs.push(dir);
    // Compile only the source under test for independent Node processes, never import build output.
    await writeFile(join(dir, "package.json"), JSON.stringify({ type: "module" }));
    for (const [source, target] of [["lib/storage/file-lock.ts", "file-lock.js"], ["lib/fs-retry.ts", "fs-retry.js"], ["lib/storage/transactions.ts", "transactions.js"]]) {
        const text = await readFile(source!, "utf8");
        await writeFile(join(dir, target!), ts.transpileModule(text.replace('"../fs-retry.js"', '"./fs-retry.js"'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText);
    }
    const worker = join(dir, "worker.mjs");
    await writeFile(worker, `import {withAccountStorageTransaction} from ${JSON.stringify(pathToFileURL(join(dir, "transactions.js")).href)};
 import {readFile,writeFile,rename} from 'node:fs/promises';
 const path=process.argv[2];
 process.send('started');
 await withAccountStorageTransaction(async(data,persist)=>{
   const release=new Promise(resolve=>process.once('message',resolve));
   process.send('entered');await release;
   data.accounts.push({recordId:String(process.pid)});await persist(data);
 },{getStoragePath:()=>path,loadCurrent:async()=>JSON.parse(await readFile(path,'utf8')),saveAccounts:async data=>{const temp=path+'.'+process.pid;await writeFile(temp,JSON.stringify(data));await rename(temp,path);}});process.send('saved');process.disconnect();`);
    const path = join(dir, "store.json");
    await writeFile(path, JSON.stringify({ version: 3, activeIndex: 0, accounts: [] }));
    return { dir, path, worker };
}
function launch(worker: string, path: string) {
    const child = fork(worker, [path], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
    children.push(child);
    const messages: string[] = [];
    child.on("message", m => messages.push(String(m)));
    const wait = async (message: string) => { const deadline = Date.now() + 4000; while (!messages.includes(message)) {
        if (Date.now() > deadline)
            throw Error(`Worker did not report ${message}`);
        await new Promise(r => setTimeout(r, 5));
    } };
    return { child, messages, wait };
}
it("serializes real processes across the read-modify-write transaction", async () => {
    const { path, worker } = await fixture();
    const a = launch(worker, path);
    await a.wait("entered");
    const b = launch(worker, path);
    await b.wait("started");
    await new Promise(r => setTimeout(r, 80));
    expect(b.messages).not.toContain("entered");
    a.child.send("go");
    await a.wait("saved");
    await b.wait("entered");
    b.child.send("go");
    await b.wait("saved");
    expect(JSON.parse(await readFile(path, "utf8")).accounts).toHaveLength(2);
});
it("recovers a killed writer without relying on a lease expiry", async () => {
    const { path, worker, dir } = await fixture();
    const a = launch(worker, path);
    await a.wait("entered");
    const exit = once(a.child, "exit");
    a.child.kill("SIGKILL");
    await exit;
    await withFileTransactionLock(path, async () => writeFile(path, '["recovered"]'));
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(["recovered"]);
    expect((await readdir(dir)).filter(p => p.includes("write-lock"))).toEqual([]);
});
it("times out visibly rather than stealing a live writer's lock", async () => {
    const { path, worker } = await fixture();
    const a = launch(worker, path);
    await a.wait("entered");
    await expect(withFileTransactionLock(path, async () => { throw Error("must not enter"); }, { waitMs: 70 })).rejects.toMatchObject({ code: "ELOCKED" });
    a.child.send("go");
    await a.wait("saved");
});
it("releases on exceptions and supports nested persistence under the same lease", async () => {
    const { path } = await fixture();
    await expect(withFileTransactionLock(path, async () => withFileTransactionLock(path, async () => { throw Error("fixture failure"); }))).rejects.toThrow("fixture failure");
    await expect(withFileTransactionLock(path, async () => 42)).resolves.toBe(42);
});
it.each(["EBUSY", "EPERM"])("retries %s while publishing the storage lease", async (code) => {
    const { path, dir } = await fixture();
    const rename = fs.rename.bind(fs);
    let blocked = false;
    const spy = vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
        if (!blocked && String(args[1]).endsWith(".write-lock")) {
            blocked = true;
            throw Object.assign(Error("fixture lock"), { code });
        }
        return rename(...args);
    });
    try {
        await expect(withFileTransactionLock(path, async () => 42)).resolves.toBe(42);
        expect(blocked).toBe(true);
        expect((await readdir(dir)).filter(p => p.includes("write-lock"))).toEqual([]);
    }
    finally {
        spy.mockRestore();
    }
});
