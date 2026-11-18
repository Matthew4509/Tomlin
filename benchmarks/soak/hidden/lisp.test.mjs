import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from './_load.mjs';

const { run } = await load('lisp.js');
const eq = (src, want) => assert.deepEqual(run(src), want, src);

test('arithmetic', () => {
  eq('(+ 1 2 3)', 6);
  eq('(* 2 (+ 3 4))', 14);
  eq('(- 10 4)', 6);
  eq('(/ 8 2)', 4);
});
test('define and lambda', () => {
  eq('(define x 5) (* x x)', 25);
  eq('((lambda (a b) (+ a b)) 3 4)', 7);
  eq('(define (sq n) (* n n)) (sq 9)', 81);
});
test('if, comparison, cond', () => {
  eq('(if (< 1 2) 10 20)', 10);
  eq('(if (> 1 2) 10 20)', 20);
  eq('(cond ((< 5 3) 1) ((> 5 3) 2) (else 3))', 2);
  eq('(cond ((< 5 3) 1) (else 9))', 9);
  eq('(= 3 3)', true);
  eq('(<= 4 3)', false);
});
test('recursion', () => {
  eq('(define (fact n) (if (< n 2) 1 (* n (fact (- n 1))))) (fact 10)', 3628800);
  eq('(define (fib n) (if (< n 2) n (+ (fib (- n 1)) (fib (- n 2))))) (fib 15)', 610);
});
test('closures keep their own variables', () => {
  eq('(define (adder n) (lambda (x) (+ x n))) ((adder 5) 10)', 15);
  eq('(define (adder n) (lambda (x) (+ x n))) (define a1 (adder 1)) (define a9 (adder 9)) (+ (a1 0) (a9 0))', 10);
  eq('(define (counter) (define n 0) (lambda () (set! n (+ n 1)) n)) (define c (counter)) (c) (c) (c)', 3);
});
test('let and begin and set!', () => {
  eq('(let ((a 2) (b 3)) (* a b))', 6);
  eq('(define n 0) (set! n (+ n 1)) (begin (set! n (+ n 1)) n)', 2);
});
test('lists', () => {
  eq('(car (list 1 2 3))', 1);
  eq('(cdr (list 1 2 3))', [2, 3]);
  eq('(cons 0 (list 1 2))', [0, 1, 2]);
  eq('(null? (list))', true);
  eq('(null? (list 1))', false);
  eq('(length (list 1 2 3 4))', 4);
  eq('(quote (1 2 3))', [1, 2, 3]);
  eq("'(4 5)", [4, 5]);
});
test('higher-order functions', () => {
  eq('(define (map f l) (if (null? l) (list) (cons (f (car l)) (map f (cdr l))))) (map (lambda (x) (* x x)) (list 1 2 3))', [1, 4, 9]);
  eq('(define (compose f g) (lambda (x) (f (g x)))) ((compose (lambda (x) (* x 2)) (lambda (x) (+ x 1))) 5)', 12);
});
test('comments and several lines', () => {
  eq('; a comment\n(+ 1 1) ; another\n', 2);
  eq('(define x 1)\n(define y 2)\n(+ x y)', 3);
});
test('an unbound name is an error that names it', () => {
  assert.throws(() => run('(foo 1)'), /foo/);
  assert.throws(() => run('(+ 1 undefined-thing)'), /undefined-thing/);
});
test('a loop of 50,000 calls in tail position does not overflow the stack', () => {
  eq('(define (sum n acc) (if (= n 0) acc (sum (- n 1) (+ acc n)))) (sum 50000 0)', 1250025000);
});
test('the state of one run does not leak into the next', () => {
  run('(define leaked 1)');
  assert.throws(() => run('leaked'), /leaked/);
});
