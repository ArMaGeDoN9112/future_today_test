import { Socket } from 'node:net';

// Запрещаем исходящие соединения сервера; HTTP-клиент теста работает в другом процессе.
Socket.prototype.connect = () => { throw new Error('Исходящая сеть запрещена в тесте'); };
globalThis.fetch = () => { throw new Error('Внешняя сеть запрещена в тесте'); };
