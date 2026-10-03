import {defineConfig} from 'vite';
export default defineConfig({base:'/privacy-lab/',server:{host:'127.0.0.1',port:18769,strictPort:true},build:{target:'esnext'}});
