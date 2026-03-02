import { Routes } from '@angular/router';
import { Home } from './home/home';
import { Editor } from './editor/editor';

export const routes: Routes = [
    { path: '', redirectTo: '/home', pathMatch: 'full' },
    { path: 'home', component: Home },
    { path: 'editor', component: Editor },
    { path: '**', redirectTo: '/home' }
];
