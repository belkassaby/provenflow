import { describe, expect, it } from 'vitest';
import { c4ViewToText, elementStyle, mergeC4Workspaces, parseC4Dsl, removeElement, viewContents, writeC4Dsl, type C4Workspace } from '../src/index.js';

const DSL = `
/* A shop, in the forms the Structurizr DSL allows. */
workspace "Shop" "Sells things." {
    !const TLS "HTTPS"

    model {
        customer = person "Customer" "Buys things." "Web"
        # A comment line.
        payments = softwareSystem "Payments" "Takes the money." "External"
        shop = softwareSystem "Shop" {
            group "Front" {
                web = container "Web app" "Pages." "Angular" "Browser"
            }
            api = container "API" "Orders and stock." "Node.js" {
                orders = component "Orders" "Takes orders." "TypeScript"
                stock = component "Stock" "Counts things." "TypeScript"
                orders -> stock "Reserves"
                -> payments "Charges" "\${TLS}"
            }
            db = container "Database" "" "PostgreSQL" "Database"
            web -> api "Calls" "JSON/\${TLS}"
            api -> db "Reads and writes"
        }
        customer -> web "Uses"
        web -> orders "Posts orders"

        live = deploymentEnvironment "Live" {
            blue = deploymentGroup "Blue"
            deploymentNode "Cloud" "" "AWS" {
                deploymentNode "Cluster" "" "Kubernetes" "" "3" {
                    containerInstance api blue
                    containerInstance web
                    lb = infrastructureNode "Load balancer" "" "ELB"
                }
                containerInstance db blue
            }
            lb -> web "Forwards"
        }
    }

    views {
        systemLandscape "landscape" {
            include *
        }
        systemContext shop "context" "The shop and its users." {
            include *
            autoLayout lr
        }
        container shop "containers" {
            include *
            autolayout tb 300 200
        }
        component api "components" {
            include *
        }
        dynamic api "checkout" "Paying." {
            orders -> stock "Reserves the items"
            orders -> payments "Charges the card"
            autoLayout
        }
        deployment shop live "deployment" {
            include *
        }
        theme default
        styles {
            element "Person" {
                shape Person
                background #08427b
                colour #ffffff
            }
            element "Database" {
                shape Cylinder
                border dashed
                strokeWidth 3
            }
            relationship "Relationship" {
                dashed false
            }
        }
    }
}
`;

const parse = (text = DSL) => {
    const result = parseC4Dsl(text);
    expect(result.diagnostics.filter(d => d.severity === 'error')).toEqual([]);
    return result.workspace;
};

describe('Structurizr DSL', () => {
    it('reads elements, nesting, groups, tags, constants and implicit sources', () => {
        const ws = parse();
        expect(ws.name).toBe('Shop');
        const byId = new Map(ws.elements.map(e => [e.id, e]));
        expect(byId.get('customer')).toMatchObject({ type: 'person', description: 'Buys things.', tags: ['Web'] });
        expect(byId.get('web')).toMatchObject({ type: 'container', parent: 'shop', group: 'Front', technology: 'Angular', tags: ['Browser'] });
        expect(byId.get('orders')).toMatchObject({ type: 'component', parent: 'api' });
        expect(byId.get('db')?.tags).toEqual(['Database']);
        const charge = ws.relationships.find(r => r.source === 'api' && r.destination === 'payments');
        expect(charge?.technology).toBe('HTTPS');
        expect(ws.relationships.find(r => r.source === 'web')?.technology).toBe('JSON/HTTPS');
    });

    it('reads deployment environments, groups, nodes and instances', () => {
        const ws = parse();
        expect(ws.environments).toEqual([{ id: 'live', name: 'Live', groups: [{ id: 'blue', name: 'Blue' }] }]);
        const instances = ws.elements.filter(e => e.type === 'containerInstance');
        expect(instances.map(i => i.instanceOf).sort()).toEqual(['api', 'db', 'web']);
        expect(instances.find(i => i.instanceOf === 'api')?.deploymentGroups).toEqual(['blue']);
        expect(ws.elements.find(e => e.name === 'Cluster')?.instances).toBe('3');
    });

    it('reads views and styles', () => {
        const ws = parse();
        expect(ws.views.map(v => `${v.type}:${v.key}`)).toEqual(['systemLandscape:landscape', 'systemContext:context', 'container:containers', 'component:components', 'dynamic:checkout', 'deployment:deployment']);
        expect(ws.views[2].autoLayout).toEqual({ direction: 'tb', rankSeparation: 300, nodeSeparation: 200 });
        expect(ws.views[4].steps).toHaveLength(2);
        const db = ws.elements.find(e => e.id === 'db')!;
        expect(elementStyle(ws, db)).toMatchObject({ shape: 'Cylinder', border: 'dashed', strokeWidth: 3 });
        expect(ws.styles.elements[0]).toMatchObject({ color: '#ffffff' });
    });

    it('reports what it cannot read, with the line, and goes on', () => {
        const { workspace, diagnostics } = parseC4Dsl('workspace {\n  model {\n    a = person "A"\n    a -> nobody "Calls"\n    frobnicate "x"\n  }\n}\n');
        expect(workspace.elements).toHaveLength(1);
        expect(diagnostics).toEqual([
            { line: 5, severity: 'warning', message: 'Unknown statement: frobnicate.' },
            { line: 4, severity: 'error', message: 'Relationship a -> nobody: no element nobody.' }
        ]);
    });

    it('writes DSL that reads back to the same model', () => {
        const ws = parse();
        const again = parse(writeC4Dsl(ws));
        expect(again.elements).toEqual(ws.elements);
        expect(again.relationships.map(r => [r.source, r.destination, r.description, r.technology])).toEqual(ws.relationships.map(r => [r.source, r.destination, r.description, r.technology]));
        expect(again.views.map(v => ({ ...v, positions: undefined }))).toEqual(ws.views.map(v => ({ ...v, positions: undefined })));
        expect(again.styles).toEqual(ws.styles);
    });
});

describe('C4 views', () => {
    const ws = parseC4Dsl(DSL).workspace;
    const view = (key: string) => viewContents(ws, ws.views.find(v => v.key === key)!);
    const edges = (key: string) => view(key).edges.map(e => `${e.source}>${e.target}`).sort();

    it('shows a system context with the relationships of nested elements implied', () => {
        expect(view('context').nodes.map(n => n.id).sort()).toEqual(['customer', 'payments', 'shop']);
        expect(edges('context')).toEqual(['customer>shop', 'shop>payments']);
        expect(view('context').edges.every(e => e.implied)).toBe(true);
    });

    it('shows the containers inside their system, grouped, with the people and systems they talk to', () => {
        const c = view('containers');
        expect(c.nodes.find(n => n.id === 'shop')?.kind).toBe('boundary');
        expect(c.nodes.find(n => n.id === 'web')?.parent).toBe('group:shop:Front');
        expect(c.nodes.find(n => n.id === 'group:shop:Front')).toMatchObject({ kind: 'group', parent: 'shop' });
        expect(edges('containers')).toEqual(['api>db', 'api>payments', 'customer>web', 'web>api']);
    });

    it('shows the components of a container, and the containers of its system that use them', () => {
        const c = view('components');
        expect(c.nodes.map(n => `${n.id}:${n.kind}`).sort()).toEqual(['api:boundary', 'group::Front:group', 'orders:element', 'stock:element', 'web:element']);
        // api -> payments is the container's own: it is not on any component.
        expect(edges('components')).toEqual(['orders>stock', 'web>orders']);
    });

    it('numbers the steps of a dynamic view', () => {
        expect(view('checkout').edges.map(e => [e.order, e.description])).toEqual([
            [1, 'Reserves the items'],
            [2, 'Charges the card']
        ]);
    });

    it('draws deployment nodes around instances, with the relationships of what they run', () => {
        const d = view('deployment');
        expect(d.nodes.filter(n => n.kind === 'boundary').map(n => n.name)).toEqual(['Cloud', 'Cluster']);
        const names = new Map(d.nodes.map(n => [n.id, n.name]));
        expect(d.edges.map(e => `${names.get(e.source)}>${names.get(e.target)}`).sort()).toEqual(['API>Database', 'Load balancer>Web app', 'Web app>API']);
    });

    it('exports a view as C4-PlantUML and Mermaid', () => {
        const containers = ws.views.find(v => v.key === 'containers')!;
        const puml = c4ViewToText(ws, containers, 'plantuml');
        expect(puml).toContain('!include https://raw.githubusercontent.com/plantuml-stdlib/C4-PlantUML/master/C4_Container.puml');
        expect(puml).toContain('System_Boundary(shop, "Shop") {');
        expect(puml).toContain('ContainerDb(db, "Database", "PostgreSQL", "")');
        expect(puml).toContain('Person(customer, "Customer", "Buys things.")');
        expect(puml).toContain('Rel(web, api, "Calls", "JSON/HTTPS")');
        const mermaid = c4ViewToText(ws, ws.views.find(v => v.key === 'context')!, 'mermaid');
        expect(mermaid.split('\n')[0]).toBe('C4Context');
        expect(mermaid).toContain('System_Ext(payments, "Payments", "Takes the money.")');
    });
});

describe('editing and merging C4 models', () => {
    it('removes an element with its children, relationships and view references', () => {
        const ws = removeElement(parseC4Dsl(DSL).workspace, 'api');
        expect(ws.elements.some(e => e.id === 'orders' || e.instanceOf === 'api')).toBe(false);
        expect(ws.relationships.some(r => r.source === 'api' || r.destination === 'api' || r.source === 'orders')).toBe(false);
        expect(ws.views.some(v => v.scope === 'api')).toBe(false);
    });

    it('merges a discovered model into a hand-written one by name, keeping what is written', () => {
        const base = parseC4Dsl(DSL).workspace;
        const discovered: C4Workspace = {
            ...parseC4Dsl('workspace { model { a = softwareSystem "@acme/web-app" { ac = container "web-app" { x = component "x" } }\n b = softwareSystem "Logger"\n ac -> b "Logs" } views { systemLandscape "projects" { include * } } }').workspace
        };
        const merged = mergeC4Workspaces(base, discovered);
        // "@acme/web-app" is the "Web app" container: its own components (none written) come in, the logger is new.
        expect(merged.elements.find(e => e.name === 'Logger')?.tags).toContain('Discovered');
        expect(merged.elements.find(e => e.name === 'x')?.parent).toBe('web');
        expect(merged.relationships.find(r => r.source === 'web' && r.destination === merged.elements.find(e => e.name === 'Logger')!.id)?.tags).toContain('Discovered');
        expect(merged.elements.filter(e => e.name === 'Shop')).toHaveLength(1);
        expect(merged.views.map(v => v.key)).toContain('projects');
    });
});
