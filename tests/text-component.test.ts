import test from 'ava';
import { componentToText, simplifyNbt } from '../src/text-component.js';

test('componentToText handles strings, JSON and nested extra', (t) => {
  t.is(componentToText('plain'), 'plain');
  t.is(componentToText('{"text":"Hello ","extra":[{"text":"world"}]}'), 'Hello world');
  t.is(componentToText({ text: '', extra: ['a', { text: 'b' }] }), 'ab');
  t.is(componentToText(undefined), '');
});

test('componentToText falls back to translation keys with arguments', (t) => {
  t.is(componentToText({ translate: 'block.minecraft.bed.no_sleep' }), 'block.minecraft.bed.no_sleep');
  t.is(componentToText({ translate: 'death.attack.arrow', with: ['Bot', { text: 'Skeleton' }] }), 'death.attack.arrow (Bot, Skeleton)');
});

test('componentToText reads network NBT components', (t) => {
  const nbt = {
    type: 'compound',
    value: {
      text: { type: 'string', value: 'Action ' },
      extra: { type: 'list', value: { type: 'string', value: ['bar'] } }
    }
  };
  t.is(componentToText(nbt), 'Action bar');
  t.is(componentToText({ type: 'string', value: 'just text' }), 'just text');
});

test('simplifyNbt unwraps nested compounds and lists', (t) => {
  t.deepEqual(simplifyNbt({
    type: 'compound',
    value: { a: { type: 'int', value: 1 }, b: { type: 'list', value: { type: 'compound', value: [{ c: { type: 'string', value: 'x' } }] } } }
  }), { a: 1, b: [{ c: 'x' }] });
});
