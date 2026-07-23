import fs from 'fs-extra';
import path from 'path';


export async function getFileTree(dir: string): Promise<string[]> {
    const names = await fs.readdir(dir);
    return (await Promise.all(names.map(async name => {
        const file = path.join(dir, name);
        if ((await fs.stat(file)).isDirectory()) {
            return await getFileTree(file);
        } else {
            return [file];
        }
    }))).flat();
}
