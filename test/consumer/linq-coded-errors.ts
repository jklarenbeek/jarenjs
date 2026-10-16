// The coded error classes a consumer constructs and catches as what they
// are: each declares its own constructor and the CodedError base its
// runtime class extends, so a consumer reads `code`, `reason`, `docPath`
// and `dataPath` without a cast.
import { LinqBuildError, LinqRuntimeError } from '@jarenjs/linq';
import { DbCompileError, DbRuntimeError } from '@jarenjs/db';
import { CodedError } from '@jarenjs/core/errors';

const build = new LinqBuildError('JL0001', 'the chain reads no row', '/where', new Error('cause'));
const runtime = new LinqRuntimeError('JL2001', 'first() of an empty sequence');
const compile = new DbCompileError('JD0001', 'the model is not a model', '/collections');
const failed = new DbRuntimeError('JD2001', 'the write was refused', { docPath: '/a', collection: 'items' });
const coded: CodedError[] = [build, runtime, compile, failed];
const where: (string | undefined)[] = coded.map((e) => e.dataPath ?? e.docPath);
const caught = (error: unknown): string | undefined => (error instanceof CodedError ? error.code : undefined);
void [where, caught(build)];
// @ts-expect-error the code comes first and is a string
void new LinqBuildError(1, 'x');
// @ts-expect-error a runtime error takes at most a code, a reason, a docPath and a cause
void new LinqRuntimeError('JL2001', 'x', '/a', new Error('c'), 'extra');
