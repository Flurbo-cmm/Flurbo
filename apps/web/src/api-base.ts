import { createContext, useContext } from 'react';

// Where shared market components read from: '/api' for members, '/api/demo' for the public read-only demo.
export const ApiBase = createContext('/api');
export const useApiBase = () => useContext(ApiBase);
