/** @type {import('tailwindcss').Config} */
export default {
    content: [
        "./src/**/*.{html,ts}",
    ],
    theme: {
        extend: {
            fontFamily: {
                mono: ['Space Mono', 'monospace'],
                sans: ['DM Sans', 'sans-serif'],
            },
            colors: {
                bg: '#0A0A0A',
                s1: '#111111',
                s2: '#1a1a1a',
                s3: '#222222',
                border: '#2a2a2a',
                border2: '#333333',
                accent: '#FAFAFA',
                green: '#00e890',
                orange: '#ff8c00',
                purple: '#b388ff',
                red: '#ff4f4f',
                yellow: '#ffd060',
                text: '#e3e3e3',
                muted: '#888888',
                probe1: '#ffe04b',
                probe2: '#ff6bb5',
                probe3: '#a8ff6b',
                probe4: '#ff9e6b',
                probe5: '#6bc1ff',
                probe6: '#ff6b6b',
                probe7: '#6bffb3',
                probe8: '#4945c5',
            },
        },
    },
    plugins: [],
}
