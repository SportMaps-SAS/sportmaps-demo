import React, { useState } from 'react';
import { CheckCircle2, Circle, ArrowRight, Sparkles, ChevronUp } from 'lucide-react';
import { readChecklistCollapsed, writeChecklistCollapsed } from '@/lib/onboarding/onboardingChecklists';
import { OnboardingStep } from '../../types/dashboard';
import { Card, CardContent } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Button } from '@/components/ui/button';

interface Props {
    steps: OnboardingStep[];
    onStepClick: (step: OnboardingStep) => void;
    /** Titulo grande. Default "Configura tu cuenta". */
    title?: string;
    /** Subtitulo de detalle. Default "Completa estos pasos para activar todas las funciones". */
    subtitle?: string;
    /**
     * Si se pasa, el checklist se puede colapsar a una píldora («2/6») y reabrir.
     * El id separa lo guardado de cada checklist (escuela, acudiente, club).
     */
    collapsibleId?: string;
}

/**
 * Checklist visual unificado con el estilo del OnboardingShell (trainer,
 * school, vendor, organizer). A diferencia de esos wizards, aqui los
 * pasos NO son secuenciales: athletes/parents/coaches pueden completar
 * en cualquier orden y cada step abre la pagina correspondiente.
 *
 * Mismo lenguaje visual: badge eyebrow "Configuracion inicial", h1
 * grande, progress bar arriba, pills clickeables por step, card
 * blanca con sombra. Asi todos los roles ven la misma estructura.
 */
export const DashboardChecklist: React.FC<Props> = ({
    steps,
    onStepClick,
    title = 'Configura tu cuenta',
    subtitle = 'Completa estos pasos para activar todas las funciones.',
    collapsibleId,
}) => {
    const [collapsed, setCollapsed] = useState(() => (collapsibleId ? readChecklistCollapsed(collapsibleId) : false));
    const setColapsado = (v: boolean) => {
        setCollapsed(v);
        if (collapsibleId) writeChecklistCollapsed(collapsibleId, v);
    };
    const completedCount = steps.filter((s) => s.completed).length;
    const progress = Math.round((completedCount / steps.length) * 100);
    const nextStep = steps.find((s) => !s.completed);

    if (steps.length === 0) return null;

    // Colapsado: una píldora que se reabre con un clic. No ocupa el panel.
    if (collapsibleId && collapsed) {
        return (
            <div className="flex justify-center">
                <button
                    type="button"
                    onClick={() => setColapsado(false)}
                    aria-label={`Mostrar ${title}: ${completedCount} de ${steps.length} pasos completados`}
                    className="inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/10 px-4 py-1.5 text-xs font-semibold text-primary hover:bg-primary/15"
                >
                    <Sparkles className="h-3 w-3" />
                    {title} · {completedCount}/{steps.length}
                </button>
            </div>
        );
    }

    return (
        <div className="space-y-6">
            {/* Header al estilo OnboardingShell */}
            <div className="text-center">
                <div className="inline-flex items-center gap-2 bg-primary/10 border border-primary/20 rounded-full px-4 py-1.5 mb-4">
                    <Sparkles className="h-3 w-3 text-primary" />
                    <span className="text-xs font-bold uppercase tracking-widest text-primary">
                        Configuración inicial
                    </span>
                </div>
                <h2 className="text-2xl md:text-3xl font-bold tracking-tight mb-2">{title}</h2>
                <p className="text-sm text-muted-foreground">
                    {nextStep
                        ? <>Siguiente paso: <span className="font-medium text-foreground">{nextStep.title}</span></>
                        : subtitle}
                </p>
                {collapsibleId && (
                    <>
                        <p className="mt-1 text-xs text-muted-foreground">{completedCount} de {steps.length} completados</p>
                        <div className="mt-3 flex items-center justify-center gap-2">
                            {nextStep && (
                                <Button size="sm" onClick={() => onStepClick(nextStep)}>
                                    {nextStep.title} <ArrowRight className="ml-1 h-4 w-4" />
                                </Button>
                            )}
                            <Button size="sm" variant="ghost" onClick={() => setColapsado(true)}>
                                <ChevronUp className="mr-1 h-4 w-4" /> Ocultar
                            </Button>
                        </div>
                    </>
                )}
            </div>

            {/* Progress bar */}
            <div className="flex items-center gap-3 max-w-2xl mx-auto">
                <Progress value={progress} className="h-1.5 flex-1" />
                <span className="text-sm font-semibold text-primary tabular-nums">{progress}%</span>
            </div>

            {/* Step pills clickeables */}
            <div className="flex items-center justify-center gap-2 flex-wrap">
                {steps.map((step) => {
                    const Icon = (step as any).icon;
                    const isCurrent = step.id === nextStep?.id;
                    return (
                        <button
                            key={step.id}
                            type="button"
                            onClick={() => onStepClick(step)}
                            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-all duration-300 cursor-pointer ${
                                isCurrent
                                    ? 'bg-primary text-primary-foreground shadow-md shadow-primary/30'
                                    : step.completed
                                    ? 'bg-primary/15 text-primary hover:bg-primary/25'
                                    : 'bg-muted text-muted-foreground hover:bg-muted/80'
                            }`}
                        >
                            {step.completed ? <CheckCircle2 className="h-3 w-3" /> : Icon ? <Icon className="h-3 w-3" /> : <Circle className="h-3 w-3" />}
                            <span className="hidden sm:inline">{step.title}</span>
                        </button>
                    );
                })}
            </div>

            {/* Lista detallada de pasos en card unificado */}
            <Card className="shadow-xl border-border/50 max-w-2xl mx-auto animate-in fade-in slide-in-from-bottom-4 duration-400">
                <CardContent className="p-4 md:p-6 space-y-3">
                    {steps.map((step) => {
                        const Icon = (step as any).icon;
                        return (
                            <button
                                key={step.id}
                                onClick={() => onStepClick(step)}
                                className={`w-full flex items-center justify-between gap-4 p-4 rounded-lg border transition-all text-left ${
                                    step.completed
                                        ? 'bg-muted/30 border-border opacity-70'
                                        : 'bg-background border-primary/20 hover:border-primary/50 hover:bg-primary/5 shadow-sm'
                                }`}
                            >
                                <div className="flex items-center gap-4 min-w-0">
                                    <div className={`h-10 w-10 rounded-xl flex items-center justify-center shrink-0 ${
                                        step.completed ? 'bg-primary/10' : 'bg-primary/10'
                                    }`}>
                                        {step.completed ? (
                                            <CheckCircle2 className="h-5 w-5 text-primary" />
                                        ) : Icon ? (
                                            <Icon className="h-5 w-5 text-primary" />
                                        ) : (
                                            <Circle className="h-5 w-5 text-primary" />
                                        )}
                                    </div>
                                    <div className="min-w-0">
                                        <p className={`font-semibold ${step.completed ? 'line-through text-muted-foreground' : ''}`}>
                                            {step.title}
                                        </p>
                                        <p className="text-xs text-muted-foreground">{step.description}</p>
                                    </div>
                                </div>
                                {!step.completed && <ArrowRight className="h-5 w-5 text-primary shrink-0" />}
                            </button>
                        );
                    })}
                </CardContent>
            </Card>
        </div>
    );
};
