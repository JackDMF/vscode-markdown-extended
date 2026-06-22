import * as assert from 'assert';
import * as fsStub from '../../../src/stubs/fs';

suite('fs stub (web)', () => {
    test('existsSync always returns false', () => {
        assert.strictEqual(fsStub.existsSync('/any/path'), false);
        assert.strictEqual(fsStub.existsSync(''), false);
    });

    test('readFileSync returns empty Buffer', () => {
        const result = fsStub.readFileSync('/any/path');
        assert.ok(Buffer.isBuffer(result));
        assert.strictEqual(result.length, 0);
    });

    test('writeFileSync is a no-op', () => {
        assert.doesNotThrow(() => fsStub.writeFileSync('/any/path', 'data'));
    });

    test('mkdirSync is a no-op', () => {
        assert.doesNotThrow(() => fsStub.mkdirSync('/any/path', { recursive: true }));
    });

    test('statSync throws', () => {
        assert.throws(() => fsStub.statSync('/any/path'), /not available in the web/);
    });

    test('exists calls callback with false', (done) => {
        fsStub.exists('/any/path', (result) => {
            assert.strictEqual(result, false);
            done();
        });
    });

    test('mkdir calls callback with no error', (done) => {
        fsStub.mkdir('/any/path', (err) => {
            assert.strictEqual(err, null);
            done();
        });
    });

    test('mkdir with options calls callback with no error', (done) => {
        fsStub.mkdir('/any/path', { recursive: true }, (err) => {
            assert.strictEqual(err, null);
            done();
        });
    });

    suite('promises', () => {
        test('writeFile resolves', async () => {
            await assert.doesNotReject(() => fsStub.promises.writeFile('/any/path', 'data'));
        });

        test('mkdir resolves', async () => {
            await assert.doesNotReject(() => fsStub.promises.mkdir('/any/path'));
        });

        test('access rejects', async () => {
            await assert.rejects(() => fsStub.promises.access('/any/path'), /web extension host/);
        });

        test('readFile rejects', async () => {
            await assert.rejects(() => fsStub.promises.readFile('/any/path'), /web extension host/);
        });

        test('rm resolves', async () => {
            await assert.doesNotReject(() => fsStub.promises.rm('/any/path'));
        });
    });
});
