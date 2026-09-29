import * as assert from 'assert';
import { SourcePosition } from '../../../src/editor/positions';
import { WebviewMessage } from '../../../src/editor/protocol';
import { CaretPort, CaretReporter } from '../../../src/editor/webview/caret';

/** A page stand-in for the caret reporter: what it would measure and what it posts. */
class FakeCaretPage implements CaretPort {
    readonly posted: Extract<WebviewMessage, { type: 'caret' }>[] = [];
    versionNow: number | undefined = 3;
    pending = false;
    text = 'text';
    held = 'text';
    caret: SourcePosition | null = { line: 0, character: 1 };

    version(): number | undefined {
        return this.versionNow;
    }
    editPending(): boolean {
        return this.pending;
    }
    hostText(): string | undefined {
        return this.held;
    }
    measure() {
        return { text: this.text, caret: this.caret };
    }
    post(message: Extract<WebviewMessage, { type: 'caret' }>): void {
        this.posted.push(message);
    }
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

suite('Editor positions: the caret the page reports', () => {
    const DELAY = 20;

    test('a burst of selection changes is one report, after the selection settles', async () => {
        const page = new FakeCaretPage();
        const reporter = new CaretReporter(page, DELAY);
        reporter.selectionMoved();
        page.caret = { line: 0, character: 2 };
        reporter.selectionMoved();
        assert.strictEqual(page.posted.length, 0, 'nothing before the delay');
        await delay(DELAY * 3);
        assert.deepStrictEqual(page.posted, [{ type: 'caret', baseVersion: 3, position: { line: 0, character: 2 } }]);
        reporter.selectionMoved();
        await delay(DELAY * 3);
        assert.strictEqual(page.posted.length, 1, 'the same caret is not reported twice');
        reporter.dispose();
    });

    test('a caret waits for the pending edit, and goes right after it', async () => {
        const page = new FakeCaretPage();
        const reporter = new CaretReporter(page, DELAY);
        page.pending = true;
        reporter.selectionMoved();
        await delay(DELAY * 3);
        assert.strictEqual(page.posted.length, 0, 'held while the edit is in the delay');
        page.pending = false;
        page.text = 'text edited';
        reporter.editSent(false);
        assert.strictEqual(page.posted.length, 0, 'held while the host holds another text');
        page.held = 'text edited';
        reporter.editSent(false);
        assert.deepStrictEqual(page.posted, [{ type: 'caret', baseVersion: 3, position: { line: 0, character: 1 } }]);
        reporter.dispose();
    });

    test('after an edit the host applied, and when the host asks, the same caret is reported again', async () => {
        const page = new FakeCaretPage();
        const reporter = new CaretReporter(page, DELAY);
        reporter.selectionMoved();
        await delay(DELAY * 3);
        reporter.editSent(false);
        assert.strictEqual(page.posted.length, 1, 'no edit went: nothing new to say');
        reporter.editSent(true);
        assert.strictEqual(page.posted.length, 2, 'an edit went: the host forgot the caret as it applied it');
        reporter.reportAgain();
        await delay(DELAY * 3);
        assert.deepStrictEqual(page.posted.map(m => m.position), [{ line: 0, character: 1 }, { line: 0, character: 1 }, { line: 0, character: 1 }]);
        reporter.dispose();
    });

    test('a new document makes the last report stale; without one nothing is reported', async () => {
        const page = new FakeCaretPage();
        const reporter = new CaretReporter(page, DELAY);
        reporter.selectionMoved();
        await delay(DELAY * 3);
        page.versionNow = 4;
        reporter.documentShown();
        await delay(DELAY * 3);
        assert.deepStrictEqual(page.posted.map(m => m.baseVersion), [3, 4]);
        page.caret = null;
        reporter.selectionMoved();
        await delay(DELAY * 3);
        assert.deepStrictEqual(page.posted[2], { type: 'caret', baseVersion: 4, position: null }, 'no caret is reported as none');
        page.versionNow = undefined;
        page.caret = { line: 5, character: 5 };
        reporter.selectionMoved();
        await delay(DELAY * 3);
        assert.strictEqual(page.posted.length, 3, 'the error state reports nothing');
        reporter.dispose();
    });
});
