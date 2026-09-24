import { ToolBoxElement } from './ToolBoxElement';
import SvgImage from '../ui/SvgImage';

export class ToolBox {
    private readonly holder: HTMLElement;
    private readonly toggleButton: HTMLButtonElement;
    private isCollapsed = false;

    constructor(list: ToolBoxElement<any>[]) {
        this.holder = document.createElement('div');
        this.holder.classList.add('control-buttons-list', 'control-wrapper');
        list.forEach((item) => {
            item.getAllElements().forEach((el) => {
                this.holder.appendChild(el);
            });
        });

        // Toggle button — inline in the toolbar as a regular button
        this.toggleButton = document.createElement('button');
        this.toggleButton.classList.add('control-button', 'toggle-button');
        this.toggleButton.title = 'Collapse toolbar';
        this.toggleButton.appendChild(SvgImage.create(SvgImage.Icon.ARROW_BACK));
        this.toggleButton.addEventListener('click', this.onToggleClick);
        this.holder.appendChild(this.toggleButton);
    }

    private onToggleClick = (): void => {
        this.isCollapsed = !this.isCollapsed;
        if (this.isCollapsed) {
            this.holder.classList.add('collapsed');
            this.toggleButton.title = 'Expand toolbar';
        } else {
            this.holder.classList.remove('collapsed');
            this.toggleButton.title = 'Collapse toolbar';
        }
    };

    public getHolderElement(): HTMLElement {
        return this.holder;
    }

    public release(): void {
        this.toggleButton.removeEventListener('click', this.onToggleClick);
    }
}
